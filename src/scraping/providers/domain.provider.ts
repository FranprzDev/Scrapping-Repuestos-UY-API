import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { parse } from 'node-html-parser';
import { ProductRecord, ProviderResult, ScrapingOperationPayload, ScrapingProvider, ScrapingTask } from '../interfaces/scraping.types';
import { extractChapareiBrandsFromHtml, extractCandidateLinks, extractProductsFromHtml } from '../domain/domain-html';
import { DomainRule, findDomainRule, getSeedUrls } from '../domain/domain-rules';
import { type HttpResponseData, fetchHtml } from '../domain/http-client';
import { cleanText, dedupeProducts, inferCurrency, normalizePriceValue, qualityGate } from '../domain/product-quality';
import { PlaywrightProvider } from './playwright.provider';

@Injectable()
export class DomainProvider implements ScrapingProvider {
  readonly name = 'domain' as const;
  private readonly logger = new Logger(DomainProvider.name);
  private readonly extractConcurrency = clampNumber(Number(process.env.DOMAIN_EXTRACT_CONCURRENCY), 1, 10, 4);

  constructor(@Inject(PlaywrightProvider) private readonly playwrightProvider: PlaywrightProvider) {}

  async run(task: ScrapingTask, payload: ScrapingOperationPayload): Promise<ProviderResult> {
    const sourceUrl = typeof payload.url === 'string' ? payload.url : undefined;

    if (!sourceUrl) {
      return {
        provider: this.name,
        task,
        requestedAt: new Date().toISOString(),
        raw: { warning: 'DomainProvider requiere url' },
        normalizedProducts: [],
      };
    }

    if (task === 'crawl') {
      const raw = await this.crawl(sourceUrl, payload);
      return {
        provider: this.name,
        task,
        requestedAt: new Date().toISOString(),
        sourceUrl,
        raw,
        normalizedProducts: [],
      };
    }

    const raw = await this.extract(sourceUrl, payload);
    return {
      provider: this.name,
      task,
      requestedAt: new Date().toISOString(),
      sourceUrl,
      raw,
      normalizedProducts: raw.products,
    };
  }

  private async crawl(sourceUrl: string, payload: ScrapingOperationPayload) {
    const rule = findDomainRule(sourceUrl);
    const limit = clampNumber(payload.limit, 1, 1000000, 30);

    if (!rule) {
      const fallback = await this.playwrightProvider.run('crawl', { ...payload, url: sourceUrl, limit });
      const raw = fallback.raw as {
        seedUrl?: string;
        pages?: Array<{ url: string; depth?: number; title?: string; links?: string[]; products?: ProductRecord[] }>;
        discoveredUrls?: string[];
      };

      return {
        seedUrl: raw.seedUrl ?? sourceUrl,
        pages: raw.pages ?? [],
        discoveredUrls: raw.discoveredUrls ?? [],
        discoveryMethod: 'playwright-fallback',
      };
    }

    if (rule.id === 'chaparei') {
      return await this.crawlChaparei(sourceUrl, limit, rule);
    }

    if (rule.id === 'selvir') {
      const response = await fetchHtml(sourceUrl);
      return {
        seedUrl: sourceUrl,
        pages: [{ url: response.finalUrl, depth: 0, productCount: extractProductsFromHtml(response.body, response.finalUrl, this.name, rule).length }],
        discoveredUrls: [sourceUrl],
        discoveryMethod: 'selvir-http',
      };
    }

    if (rule.id === 'taxitor') {
      return await this.crawlTaxitor(sourceUrl, limit, rule);
    }

    if (rule.preferredMethod === 'api') {
      return {
        seedUrl: sourceUrl,
        pages: [{ url: sourceUrl, title: rule.id, depth: 0, productCount: 0 }],
        discoveredUrls: [sourceUrl],
        discoveryMethod: 'domain-api',
      };
    }

    const queue = getSeedUrls(sourceUrl, rule).map((url) => ({ url, depth: 0 }));
    const visited = new Set<string>();
    const discoveredProducts = new Set<string>();
    const pages: Array<{ url: string; depth: number; productCount: number }> = [];

    while (queue.length > 0 && pages.length < limit) {
      const current = queue.shift();
      if (!current || visited.has(current.url)) {
        continue;
      }

      visited.add(current.url);

      try {
        const response = await fetchHtml(current.url);
        const { productLinks, categoryLinks } = extractCandidateLinks(response.body, response.finalUrl, rule);
        productLinks.forEach((url) => discoveredProducts.add(url));
        pages.push({
          url: response.finalUrl,
          depth: current.depth,
          productCount: productLinks.length,
        });

        if (current.depth >= 2) {
          continue;
        }

        for (const categoryUrl of categoryLinks) {
          if (visited.has(categoryUrl) || queue.length + pages.length >= limit) {
            continue;
          }

          queue.push({ url: categoryUrl, depth: current.depth + 1 });
        }
      } catch (error) {
        this.logger.warn(`No se pudo descubrir ${current.url}: ${formatError(error)}`);
      }
    }

    return {
      seedUrl: sourceUrl,
      pages,
      discoveredUrls: Array.from(discoveredProducts),
      discoveryMethod: 'domain-http',
    };
  }

  private async extract(sourceUrl: string, payload: ScrapingOperationPayload) {
    const rule = findDomainRule(sourceUrl);
    const maxItems = clampNumber(payload.maxItems, 1, 1000000, 150);
    const urls = uniqueStrings([
      ...(Array.isArray(payload.urls) ? payload.urls.filter((value): value is string => typeof value === 'string') : []),
      sourceUrl,
    ]);

    if (!rule) {
      const fallback = await this.playwrightProvider.run('extract', { ...payload, urls, url: sourceUrl });
      return {
        urls,
        pages: [],
        products: qualityGate(fallback.normalizedProducts),
        fallback: 'playwright',
      };
    }

    if (rule.preferredMethod === 'api') {
      const products = await this.extractAcesurProducts(sourceUrl, maxItems);
      return {
        urls: [sourceUrl],
        pages: [{ url: sourceUrl, method: 'api', productCount: products.length }],
        products: qualityGate(products, rule).slice(0, maxItems),
      };
    }

    if (rule.id === 'chaparei') {
      const chaparei = await this.extractChapareiProducts(urls, maxItems, rule);
      return {
        urls: chaparei.urls,
        pages: chaparei.pages,
        products: dedupeProducts(qualityGate(chaparei.products, rule)).slice(0, maxItems),
      };
    }

    const processed = await mapWithConcurrency(urls, this.extractConcurrency, async (url) => {
      let usableProducts: ProductRecord[] = [];
      let method = 'http';

      try {
        if (rule.id === 'selvir') {
          const response = await fetchHtml(url);
          const archiveSummary = extractSelvirArchiveSummary(response.body, response.finalUrl);

          if (archiveSummary) {
            usableProducts = await this.extractSelvirArchiveProducts(url, response, archiveSummary, maxItems, rule);
            method = 'selvir-ajax';
          } else {
            usableProducts = qualityGate(extractProductsFromHtml(response.body, response.finalUrl, this.name, rule), rule);
          }
        } else {
          const response = await fetchHtml(url);
          usableProducts = qualityGate(extractProductsFromHtml(response.body, response.finalUrl, this.name, rule), rule);
        }
      } catch (error) {
        this.logger.warn(`HTTP scrape fallido para ${url}: ${formatError(error)}`);
      }

      if (usableProducts.length === 0 && rule.preferredMethod === 'playwright-fallback') {
        const fallback = await this.playwrightProvider.run('extract', { urls: [url], url, maxItems });
        usableProducts = qualityGate(fallback.normalizedProducts, rule);
        method = 'playwright-fallback';
      }

      return {
        page: {
          url,
          method,
          productCount: usableProducts.length,
        },
        products: usableProducts,
      };
    });

    const pages = processed.map((item) => item.page);
    const collected = processed.flatMap((item) => item.products).slice(0, maxItems);

    return {
      urls,
      pages,
      products: dedupeProducts(collected).slice(0, maxItems),
    };
  }

  private async crawlChaparei(sourceUrl: string, limit: number, rule: DomainRule) {
    const session = createChapareiSession();

    try {
      const response = await session.fetch(sourceUrl);
      const brandSeeds = this.resolveChapareiBrandSeeds(response, sourceUrl).slice(0, limit);

      return {
        seedUrl: sourceUrl,
        pages: [{ url: response.finalUrl, depth: 0, productCount: brandSeeds.length }],
        discoveredUrls: brandSeeds,
        discoveryMethod: 'chaparei-http',
      };
    } catch (error) {
      this.logger.warn(`No se pudo descubrir Chaparei ${sourceUrl}: ${formatError(error)}`);
      return {
        seedUrl: sourceUrl,
        pages: [],
        discoveredUrls: [sourceUrl],
        discoveryMethod: 'chaparei-http',
      };
    }
  }

  private async extractChapareiProducts(urls: string[], maxItems: number, rule: DomainRule) {
    const discoveryUrls = uniqueStrings(urls);
    const brandSeeds = new Set<string>();

    for (const discoveryUrl of discoveryUrls) {
      try {
        const session = createChapareiSession();
        const response = await session.fetch(discoveryUrl);
        this.resolveChapareiBrandSeeds(response, discoveryUrl).forEach((value) => brandSeeds.add(value));
      } catch (error) {
        this.logger.warn(`No se pudo resolver Chaparei ${discoveryUrl}: ${formatError(error)}`);
      }
    }

    const brandUrls = Array.from(brandSeeds);
    if (brandUrls.length === 0) {
      return {
        urls: discoveryUrls,
        pages: [],
        products: [] as ProductRecord[],
      };
    }

    const results = await mapWithConcurrency(brandUrls, this.extractConcurrency, async (brandUrl) =>
      this.extractChapareiBrandSeries(brandUrl, maxItems, rule),
    );

    return {
      urls: brandUrls,
      pages: results.flatMap((item) => item.pages),
      products: dedupeProducts(results.flatMap((item) => item.products)).slice(0, maxItems),
    };
  }

  private async extractChapareiBrandSeries(brandUrl: string, maxItems: number, rule: DomainRule) {
    const session = createChapareiSession();
    const pages: Array<{ url: string; method: string; productCount: number }> = [];
    const collected: ProductRecord[] = [];

    try {
      const firstResponse = await session.fetch(brandUrl);
      const firstBatch = qualityGate(extractProductsFromHtml(firstResponse.body, firstResponse.finalUrl, this.name, rule), rule);

      if (firstBatch.length > 0) {
        collected.push(...firstBatch);
        pages.push({
          url: firstResponse.finalUrl,
          method: 'http',
          productCount: firstBatch.length,
        });
      }

      for (let page = 1; collected.length < maxItems; page += 1) {
        const ajaxUrl = buildChapareiAjaxPageUrl(firstResponse.finalUrl, page);
        const ajaxResponse = await session.fetch(ajaxUrl);

        if (!ajaxResponse.body.trim()) {
          break;
        }

        const batch = qualityGate(extractProductsFromHtml(ajaxResponse.body, ajaxResponse.finalUrl, this.name, rule), rule);
        if (batch.length === 0) {
          break;
        }

        const merged = dedupeProducts([...collected, ...batch]).slice(0, maxItems);
        if (merged.length <= collected.length) {
          break;
        }

        collected.length = 0;
        collected.push(...merged);
        pages.push({
          url: ajaxResponse.finalUrl,
          method: 'http',
          productCount: batch.length,
        });
      }
    } catch (error) {
      this.logger.warn(`No se pudo extraer Chaparei ${brandUrl}: ${formatError(error)}`);
    }

    return {
      pages,
      products: collected,
    };
  }

  private resolveChapareiBrandSeeds(response: HttpResponseData, sourceUrl: string): string[] {
    const homeBrands = extractChapareiBrandsFromHtml(response.body, response.finalUrl).map((brand) => brand.sourceUrl);
    if (homeBrands.length > 0 && isChapareiBrandHubUrl(response.finalUrl)) {
      return homeBrands;
    }

    const canonicalBrandUrl = extractChapareiCanonicalBrandUrl(response.body, response.finalUrl);
    if (canonicalBrandUrl) {
      return [canonicalBrandUrl];
    }

    if (homeBrands.length > 0) {
      return homeBrands;
    }

    return [sourceUrl];
  }

  private async extractAcesurProducts(seedUrl: string, maxItems: number): Promise<ProductRecord[]> {
    const uuid = randomUUID();
    const customerCode = process.env.ACESUR_CUSTOMER_CODE?.trim();
    this.logger.log(`Acesur extract start seed=${seedUrl} customerCode=${customerCode ? 'yes' : 'no'}`);
    const rubros = await fetchAcesurRubros(uuid, customerCode);
    this.logger.log(`Acesur rubros found count=${rubros.length}`);
    return extractAcesurProductsByRubro(rubros, {
      uuid,
      seedUrl,
      provider: this.name,
      maxItems,
      logger: this.logger,
      customerCode,
      crawlCategory: crawlAcesurCategory,
    });
  }

  private async extractSelvirArchiveProducts(
    categoryUrl: string,
    initialResponse: Awaited<ReturnType<typeof fetchHtml>>,
    archiveSummary: { categoryLabel: string; totalResults?: number; totalPages?: number },
    maxItems: number,
    rule: DomainRule,
  ): Promise<ProductRecord[]> {
    const products = qualityGate(
      extractProductsFromHtml(initialResponse.body, initialResponse.finalUrl, this.name, rule),
      rule,
    );
    const totalPages = archiveSummary.totalPages ?? 1;
    const pageUrlBase = initialResponse.finalUrl;

    for (let page = 2; page <= totalPages && products.length < maxItems; page += 1) {
      const ajaxResponse = await fetchSelvirArchivePage(categoryUrl, archiveSummary.categoryLabel, page);
      const ajaxPayload = parseSelvirAjaxResponse(ajaxResponse.body);
      let batch = qualityGate(
        extractProductsFromHtml(ajaxPayload.html, pageUrlBase, this.name, rule),
        rule,
      );

      if (batch.length === 0) {
        try {
          const fallbackResponse = await fetchHtml(buildSelvirArchivePageUrl(pageUrlBase, page));
          batch = qualityGate(
            extractProductsFromHtml(fallbackResponse.body, fallbackResponse.finalUrl, this.name, rule),
            rule,
          );
        } catch (error) {
          this.logger.warn(`No se pudo leer pagina Selvir ${pageUrlBase} page=${page}: ${formatError(error)}`);
        }
      }

      if (batch.length === 0) {
        break;
      }

      const merged = dedupeProducts([...products, ...batch]).slice(0, maxItems);
      if (merged.length <= products.length) {
        break;
      }

      products.length = 0;
      products.push(...merged);

      if (ajaxPayload.last) {
        break;
      }
    }

    return dedupeProducts(products).slice(0, maxItems);
  }

  private async crawlTaxitor(sourceUrl: string, limit: number, rule: DomainRule) {
    const pages: Array<{ url: string; depth: number; productCount: number }> = [];
    const discoveredUrls: string[] = [];
    const seenPageUrls = new Set<string>();
    const collectedProducts: ProductRecord[] = [];
    let nextUrl: string | undefined = sourceUrl;

    while (nextUrl && pages.length < limit) {
      if (seenPageUrls.has(nextUrl)) {
        break;
      }

      seenPageUrls.add(nextUrl);

      try {
        this.logger.log(`Taxitor fetch page=${nextUrl}`);
        const response = await fetchHtml(nextUrl);
        const pageProducts = qualityGate(
          extractProductsFromHtml(response.body, response.finalUrl, this.name, rule),
          rule,
        );
        const pagination = extractTaxitorPaginationSummary(response.body, response.finalUrl);

        if (pageProducts.length === 0) {
          break;
        }

        const mergedProducts = dedupeProducts([...collectedProducts, ...pageProducts]);
        if (mergedProducts.length <= collectedProducts.length) {
          break;
        }

        collectedProducts.length = 0;
        collectedProducts.push(...mergedProducts);
        pages.push({
          url: response.finalUrl,
          depth: pages.length,
          productCount: pageProducts.length,
        });
        this.logger.log(`Taxitor page_ok page=${response.finalUrl} products=${pageProducts.length}`);
        discoveredUrls.push(response.finalUrl);

        if (!pagination.nextPageUrl || seenPageUrls.has(pagination.nextPageUrl)) {
          break;
        }

        nextUrl = pagination.nextPageUrl;
      } catch (error) {
        this.logger.warn(`No se pudo leer pagina Taxitor ${nextUrl}: ${formatError(error)}`);
        break;
      }
    }

    if (discoveredUrls.length === 0) {
      discoveredUrls.push(sourceUrl);
    }

    return {
      seedUrl: sourceUrl,
      pages,
      discoveredUrls,
      discoveryMethod: 'taxitor-http',
    };
  }
}

export function buildSelvirArchivePageUrl(baseUrl: string, page: number): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(`page/${page}/`, normalizedBase).toString();
}

export function parseAcesurApi(body: string, sourceUrl: string, provider: 'domain'): { totalRecords?: number; products: ProductRecord[] } {
  const parsed = JSON.parse(body) as { cantidad_registros?: string; productos?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const items = Array.isArray(parsed) ? parsed : parsed.productos ?? [];
  const totalRecords = Number((Array.isArray(parsed) ? undefined : parsed.cantidad_registros) ?? 0);
    const products = items.reduce<ProductRecord[]>((accumulator, item) => {
      const stock = String(item.stock ?? '').trim();
      const stockValue = Number(stock.replace(',', '.'));
      const noComprable = String(item.no_comprable ?? '').toUpperCase();
      const rawPrice = String(item.precio ?? item.precio_anterior_con_iva ?? '').trim();

      accumulator.push({
        productName: String(item.descripcion_corta ?? '').trim() || String(item.descripcion_larga ?? '').trim(),
        price: rawPrice ? normalizePriceValue(rawPrice) : undefined,
        currency: inferCurrency(String(item.moneda ?? '$')),
        brand: String(item.marca ?? '').trim() || undefined,
        category: [item.rubro, item.subrubro].filter(Boolean).join(' / ') || undefined,
        description: String(item.descripcion_larga ?? item.comentarios ?? '').trim() || undefined,
        availability:
          noComprable === 'S'
            ? 'out_of_stock'
            : Number.isNaN(stockValue)
              ? 'unknown'
              : stockValue > 0
                ? 'in_stock'
                : 'out_of_stock',
        stock,
        sourceUrl: `${sourceUrl}?codigo=${encodeURIComponent(String(item.codigo ?? item.codigo_fabrica ?? ''))}`,
        imageUrl: buildAcesurImageUrl(String(item.nombre_foto ?? '').trim()),
        attributes: {
          oferta: String(item.oferta ?? ''),
          promocion: String(item.promocion ?? ''),
        },
        extractedAt: new Date().toISOString(),
        provider,
      });

      return accumulator;
    }, []);

  return { totalRecords, products };
}

export function parseAcesurFilterOptions(body: string): string[] {
  const parsed = JSON.parse(body) as Array<{ tipo?: string; codigo?: string }>;
  return parsed
    .filter((item) => String(item.tipo ?? '').toUpperCase() === 'B')
    .map((item) => String(item.codigo ?? '').trim())
    .filter(Boolean);
}

export async function extractAcesurProductsByRubro(
  rubros: string[],
  options: {
    uuid: string;
    seedUrl: string;
    provider: 'domain';
    maxItems: number;
    logger: Logger;
    customerCode?: string;
    crawlCategory: typeof crawlAcesurCategory;
  },
): Promise<ProductRecord[]> {
  const categorySeeds = rubros.length > 0 ? rubros.map((rubro) => ({ primerFiltro: rubro })) : [{ primerFiltro: '' }];
  const products: ProductRecord[] = [];

  for (const seed of categorySeeds) {
    if (products.length >= options.maxItems) {
      break;
    }

    try {
      const batch = await options.crawlCategory(
        options.uuid,
        seed,
        options.seedUrl,
        options.provider,
        options.maxItems - products.length,
        options.logger,
        options.customerCode,
      );

      if (batch.length === 0) {
        continue;
      }

      products.push(...batch);
    } catch (error) {
      options.logger.warn(`Acesur rubro fallido rubro=${seed.primerFiltro || 'todos'}: ${formatError(error)}`);
    }
  }

  return dedupeProducts(products).slice(0, options.maxItems);
}

async function crawlAcesurCategory(
  uuid: string,
  filters: { primerFiltro: string; segundoFiltro?: string; tercerFiltro?: string; cuartoFiltro?: string },
  sourceUrl: string,
  provider: 'domain',
  maxItems: number,
  logger: Logger,
  customerCode?: string,
): Promise<ProductRecord[]> {
  if (maxItems <= 0) {
    return [];
  }

  logger.log(`Acesur fetch page=1 rubro=${filters.primerFiltro || 'todos'}`);
  const firstPage = await fetchHtml(buildAcesurEndpoint(uuid, 1, filters, customerCode));
  const firstBatch = parseAcesurApi(firstPage.body, sourceUrl, provider);
  const total = Number(firstBatch.totalRecords ?? firstBatch.products.length);
  const totalPages = Math.max(1, Math.ceil(total / 20));
  const products = [...firstBatch.products];
  logger.log(`Acesur page=1 rubro=${filters.primerFiltro || 'todos'} total=${total} firstBatch=${firstBatch.products.length}`);

  for (let page = 2; page <= totalPages && products.length < maxItems; page += 1) {
    try {
      logger.log(`Acesur fetch page=${page} rubro=${filters.primerFiltro || 'todos'}`);
      const response = await fetchHtml(buildAcesurEndpoint(uuid, page, filters, customerCode));
      const batch = parseAcesurApi(response.body, sourceUrl, provider);
      if (batch.products.length === 0) {
        logger.warn(`Acesur empty page=${page} rubro=${filters.primerFiltro || 'todos'}`);
        break;
      }

      products.push(...batch.products);
    } catch (error) {
      logger.warn(`Fallo leyendo Acesur pagina ${page} (${filters.primerFiltro || 'todos'}): ${formatError(error)}`);
      break;
    }
  }

  return products;
}

async function fetchAcesurRubros(uuid: string, customerCode?: string): Promise<string[]> {
  const response = await fetchHtml(buildAcesurFilterEndpoint(uuid, 1, {}, customerCode));
  const rubros = parseAcesurFilterOptions(response.body);
  return rubros.filter((value) => value.toUpperCase() !== 'TODOS');
}

export function buildAcesurEndpoint(uuid: string, page: number, filters: { primerFiltro?: string; segundoFiltro?: string; tercerFiltro?: string; cuartoFiltro?: string } = {}, customerCode?: string): string {
  return buildAcesurUrl('app_obtener_productos.php', uuid, {
    pagina: String(page),
    order_by: '',
    tipo_orden: '',
    sucursal_pedido: '',
    primer_filtro: filters.primerFiltro ?? '',
    segundo_filtro: filters.segundoFiltro ?? '',
    tercer_filtro: filters.tercerFiltro ?? '',
    cuarto_filtro: filters.cuartoFiltro ?? '',
  }, customerCode);
}

function buildAcesurFilterEndpoint(
  uuid: string,
  filterNumber: 1 | 2 | 3 | 4,
  filters: { primero?: string; segundo?: string; tercero?: string; ultimo?: string } = {},
  customerCode?: string,
): string {
  return buildAcesurUrl(`app_obtener_buscador_${filterNumber}_filtro.php`, uuid, {
    ultimo: filters.ultimo ?? '',
    primero: filters.primero ?? '',
    segundo: filters.segundo ?? '',
    tercero: filters.tercero ?? '',
  }, customerCode);
}

function buildAcesurUrl(
  path: string,
  uuid: string,
  params: Record<string, string>,
  customerCode?: string,
): string {
  const query = new URLSearchParams({
    uuid,
    uuid_carro: `${uuid}|${customerCode ?? ''}`,
    codigo_cliente: customerCode ?? '',
    pais: '',
    ...params,
  });

  return `https://acesur.uy/app_endpoints_v4/${path}?${query.toString()}`;
}

function buildAcesurImageUrl(imageName: string): string | undefined {
  if (!imageName) {
    return undefined;
  }

  return `https://acesur.uy/fotos_articulos/${imageName}`;
}

export function extractSelvirArchiveSummary(body: string, finalUrl: string): { categoryLabel: string; totalResults?: number; totalPages?: number } | undefined {
  const root = parse(body);
  const title = cleanSelvirLabel(
    root.querySelector('h1')?.text
      ?? root.querySelector('.woocommerce-breadcrumb')?.text
      ?? root.querySelector('title')?.text,
  );

  if (!title) {
    return undefined;
  }

  const text = root.text ?? '';
  const resultsMatch =
    text.match(/mostrando\s+\d+\s*[–-]\s*\d+\s+de\s+(\d+)\s+resultados/i)
    ?? text.match(/mostrando\s+los\s+(\d+)\s+resultados/i);
  if (!resultsMatch) {
    return undefined;
  }
  const totalResults = resultsMatch ? Number(resultsMatch[1]) : undefined;
  const totalPages = totalResults ? Math.max(1, Math.ceil(totalResults / 30)) : undefined;

  if (/\/product\//i.test(finalUrl)) {
    return undefined;
  }

  return {
    categoryLabel: title,
    totalResults,
    totalPages,
  };
}

export function extractTaxitorPaginationSummary(body: string, finalUrl: string): {
  currentPage?: number;
  nextPageUrl?: string;
  lastPageUrl?: string;
} {
  const root = parse(body);
  const paginationLinks = root.querySelectorAll('ul.pagination a[href]');
  const currentPage = parseTaxitorPageNumber(
    cleanText(root.querySelector('ul.pagination li.active span')?.text)
      ?? cleanText(root.querySelector('li.active span')?.text),
  );

  let nextPageUrl: string | undefined;
  let lastPageUrl: string | undefined;
  let fallbackNextPage: { pageNumber: number; href: string } | undefined;

  for (const anchor of paginationLinks) {
    const href = normalizeTaxitorPaginationUrl(anchor.getAttribute('href'), finalUrl);
    if (!href) {
      continue;
    }

    const rel = (anchor.getAttribute('rel') ?? '').toLowerCase();
    const pageNumber = parseTaxitorPageNumber(anchor.getAttribute('data-ci-pagination-page'));
    const label = cleanText(anchor.text);

    if (rel.includes('next')) {
      nextPageUrl = href;
    }

    if (rel.includes('last') || label === '»') {
      lastPageUrl = href;
    }

    if (!nextPageUrl && typeof currentPage === 'number' && typeof pageNumber === 'number' && pageNumber > currentPage) {
      if (!fallbackNextPage || pageNumber < fallbackNextPage.pageNumber) {
        fallbackNextPage = { pageNumber, href };
      }
    }

    if (!lastPageUrl && typeof pageNumber === 'number' && label === '»') {
      lastPageUrl = href;
    }
  }

  return {
    currentPage,
    nextPageUrl: nextPageUrl ?? fallbackNextPage?.href,
    lastPageUrl,
  };
}

async function fetchSelvirArchivePage(categoryUrl: string, categoryLabel: string, page: number) {
  const body = new URLSearchParams({
    action: 'infinite_scroll_archive_products',
    category: categoryLabel,
    page: String(page),
    orderby: 'menu_order',
  }).toString();

  return fetchHtml('https://www.selvir.com.uy/wp-admin/admin-ajax.php', 3, {
    method: 'POST',
    body,
    headers: {
      origin: 'https://www.selvir.com.uy',
      referer: categoryUrl,
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
  });
}

export function parseSelvirAjaxResponse(body: string): { html: string; cantArticulos?: number; last?: boolean } {
  try {
    const parsed = JSON.parse(body) as { d?: unknown; cantArticulos?: unknown; last?: unknown };
    if (parsed && typeof parsed.d === 'string') {
      return {
        html: parsed.d,
        cantArticulos: typeof parsed.cantArticulos === 'number' ? parsed.cantArticulos : undefined,
        last: typeof parsed.last === 'boolean' ? parsed.last : undefined,
      };
    }
  } catch {
    // Selvir returns plain HTML on some responses; keep that path working.
  }

  return { html: body };
}

export function cleanSelvirLabel(value?: string): string | undefined {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return undefined;
  }

  let normalized = cleaned;
  while (/^(?:Inicio|Home|Productos)\s*\/\s*/i.test(normalized)) {
    normalized = normalized.replace(/^(?:Inicio|Home|Productos)\s*\/\s*/i, '');
  }

  return normalized
    .replace(/\s+Orden predeterminado.*$/i, '')
    .replace(/\s+archivos?\s*-\s*Selvir$/i, '')
    .replace(/\s*-\s*Selvir$/i, '')
    .trim() || undefined;
}

function createChapareiSession() {
  let cookieHeader: string | undefined;

  return {
    async fetch(url: string): Promise<HttpResponseData> {
      const response = await fetchHtml(url, 5, {
        headers: cookieHeader
          ? {
              cookie: cookieHeader,
            }
          : undefined,
      });

      cookieHeader = mergeChapareiCookies(cookieHeader, response.headers['set-cookie']);
      return response;
    },
  };
}

function mergeChapareiCookies(current: string | undefined, setCookieHeader: string | string[] | undefined): string | undefined {
  const jar = new Map<string, string>();

  if (current) {
    current.split(/;\s*/).forEach((entry) => {
      const index = entry.indexOf('=');
      if (index > 0) {
        jar.set(entry.slice(0, index), entry.slice(index + 1));
      }
    });
  }

  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  for (const cookie of cookies) {
    const pair = cookie.split(';', 1)[0]?.trim();
    const index = pair.indexOf('=');
    if (index > 0) {
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  if (jar.size === 0) {
    return current;
  }

  return Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

function buildChapareiAjaxPageUrl(pageUrl: string, page: number): string {
  const url = new URL(pageUrl);
  url.pathname = '/productos/includes/cargar_pagina_dinamica.php';
  url.searchParams.set('nro_pag', String(page));
  if (!url.searchParams.has('zona')) {
    url.searchParams.set('zona', '0');
  }
  if (!url.searchParams.has('order')) {
    url.searchParams.set('order', '255');
  }
  if (!url.searchParams.has('mo')) {
    url.searchParams.set('mo', '1');
  }

  return url.toString();
}

function isChapareiBrandHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/productos/' && !parsed.searchParams.has('m');
  } catch {
    return false;
  }
}

function extractChapareiCanonicalBrandUrl(html: string, baseUrl: string): string | undefined {
  const root = parse(html);
  const selected = root.querySelector('select#id_marca option[selected][value]') ?? root.querySelector('select#id_marca option[selected="selected"][value]');
  const brandId = cleanText(selected?.getAttribute('value'));
  if (!brandId || !/^\d+$/.test(brandId)) {
    return undefined;
  }

  try {
    return new URL(`/productos/?m=${brandId}`, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeTaxitorPaginationUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function parseTaxitorPageNumber(value: string | undefined): number | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return undefined;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const safeConcurrency = Math.max(1, Math.min(concurrency, 20));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(safeConcurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}
