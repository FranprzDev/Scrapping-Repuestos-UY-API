import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { parse } from 'node-html-parser';
import { ProductRecord, ProviderResult, ScrapingOperationPayload, ScrapingProvider, ScrapingTask } from '../interfaces/scraping.types';
import { extractCandidateLinks, extractProductsFromHtml } from '../domain/domain-html';
import { DomainRule, findDomainRule, getSeedUrls } from '../domain/domain-rules';
import { fetchHtml } from '../domain/http-client';
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
      if (shouldUsePlaywrightForChaparei()) {
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
          discoveryMethod: 'chaparei-playwright',
        };
      }

      const response = await fetchHtml(sourceUrl);
      const { productLinks, categoryLinks } = extractCandidateLinks(response.body, response.finalUrl, rule);
      const nestedCategoryLinks = await mapWithConcurrency(
        uniqueStrings(categoryLinks).slice(0, limit),
        5,
        async (categoryUrl) => {
          try {
            const nestedResponse = await fetchHtml(categoryUrl);
            const nestedLinks = extractCandidateLinks(nestedResponse.body, nestedResponse.finalUrl, rule);
            return uniqueStrings([
              ...nestedLinks.categoryLinks,
              ...nestedLinks.productLinks.filter((url) => isChapareiDetailUrl(url)),
            ]);
          } catch (error) {
            this.logger.warn(`No se pudo explorar categoria Chaparei ${categoryUrl}: ${formatError(error)}`);
            return [];
          }
        },
      );

      const discoveredUrls = uniqueStrings([
        ...categoryLinks,
        ...productLinks.filter((url) => isChapareiDetailUrl(url)),
        ...nestedCategoryLinks.flat(),
      ]);

      return {
        seedUrl: sourceUrl,
        pages: [{ url: response.finalUrl, depth: 0, productCount: discoveredUrls.length }],
        discoveredUrls,
        discoveryMethod: 'chaparei-http',
      };
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

    if (rule.id === 'chaparei' && shouldUsePlaywrightForChaparei()) {
      const fallback = await this.playwrightProvider.run('extract', { ...payload, urls, url: sourceUrl, maxItems });
      return {
        urls,
        pages: [],
        products: qualityGate(fallback.normalizedProducts, rule).slice(0, maxItems),
        fallback: 'playwright',
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

function isChapareiDetailUrl(url: string): boolean {
  return /\/catalogo\/[^/?#]+\/.+\/?$/i.test(url);
}

function shouldUsePlaywrightForChaparei(): boolean {
  return process.env.CHAPAREI_PROVIDER?.trim().toLowerCase() === 'playwright';
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
