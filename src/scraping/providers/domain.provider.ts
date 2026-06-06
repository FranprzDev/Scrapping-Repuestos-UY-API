import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProductRecord, ProviderResult, ScrapingOperationPayload, ScrapingProvider, ScrapingTask } from '../interfaces/scraping.types';
import { extractCandidateLinks, extractProductsFromHtml } from '../domain/domain-html';
import { DomainRule, findDomainRule, getSeedUrls } from '../domain/domain-rules';
import { fetchHtml } from '../domain/http-client';
import { dedupeProducts, inferCurrency, normalizePriceValue, qualityGate } from '../domain/product-quality';
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

    const processed = await mapWithConcurrency(urls, this.extractConcurrency, async (url) => {
      let usableProducts: ProductRecord[] = [];
      let method = 'http';

      try {
        const response = await fetchHtml(url);
        usableProducts = qualityGate(extractProductsFromHtml(response.body, response.finalUrl, this.name, rule), rule);
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
    const firstPage = await fetchHtml(buildAcesurEndpoint(uuid, 1));
    const firstBatch = parseAcesurApi(firstPage.body, seedUrl, this.name);
    const total = Number(firstBatch.totalRecords ?? firstBatch.products.length);
    const totalPages = Math.max(1, Math.ceil(total / 20));
    const products = [...firstBatch.products];

    for (let page = 2; page <= totalPages && products.length < maxItems; page += 1) {
      try {
        const response = await fetchHtml(buildAcesurEndpoint(uuid, page));
        const batch = parseAcesurApi(response.body, seedUrl, this.name);
        if (batch.products.length === 0) {
          break;
        }

        products.push(...batch.products);
      } catch (error) {
        this.logger.warn(`Fallo leyendo Acesur pagina ${page}: ${formatError(error)}`);
        break;
      }
    }

    return dedupeProducts(products).slice(0, maxItems);
  }
}

function parseAcesurApi(body: string, sourceUrl: string, provider: 'domain'): { totalRecords?: number; products: ProductRecord[] } {
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
        sku: String(item.codigo ?? item.codigo_fabrica ?? '').trim() || undefined,
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

function buildAcesurEndpoint(uuid: string, page: number): string {
  return `https://acesur.uy/app_endpoints_v4/app_obtener_productos.php?uuid=${uuid}&uuid_carro=${uuid}%7C&codigo_cliente=&pais=&ofertas=INTERNET&seccion=menu&texto=&pagina=${page}&order_by=&tipo_orden=&sucursal_pedido=`;
}

function buildAcesurImageUrl(imageName: string): string | undefined {
  if (!imageName) {
    return undefined;
  }

  return `https://acesur.uy/fotos_articulos/${imageName}`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
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
