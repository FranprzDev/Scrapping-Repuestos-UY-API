import { Injectable } from '@nestjs/common';
import { CatalogScrapeRequestDto, DEFAULT_CATALOG_SITES } from './dto/catalog-request.dto';
import { ProductRecord, ScrapingOperationPayload } from './interfaces/scraping.types';
import { InventoryStoreService } from './inventory/inventory-store.service';
import { ScrapingService } from './scraping.service';

const PRODUCT_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          price: { type: 'string' },
          currency: { type: 'string' },
          sku: { type: 'string' },
          brand: { type: 'string' },
          stock: { type: 'string' },
          availability: { type: 'string' },
          productUrl: { type: 'string' },
        },
        required: ['name', 'price'],
      },
    },
  },
  required: ['products'],
};

@Injectable()
export class CatalogScrapingService {
  constructor(
    private readonly scrapingService: ScrapingService,
    private readonly inventoryStoreService: InventoryStoreService,
  ) {}

  async scrapeCatalogWithPrices(request: CatalogScrapeRequestDto) {
    const urls = request.urls?.length ? request.urls : [...DEFAULT_CATALOG_SITES];
    const maxPagesPerSite = request.maxPagesPerSite ?? 30;
    const maxProductsPerSite = request.maxProductsPerSite ?? 150;
    const runAt = new Date().toISOString();

    const results = await Promise.all(
      urls.map(async (url) => {
        const crawlPayload: ScrapingOperationPayload = {
          url,
          limit: maxPagesPerSite,
          scrapeOptions: {
            formats: ['markdown', 'links'],
            onlyMainContent: true,
          },
        };

        const crawled = await this.scrapingService.runTask('crawl', crawlPayload);
        const targetUrls = collectTargetUrls(crawled.raw, url, maxPagesPerSite);

        const extractPayload: ScrapingOperationPayload = {
          urls: targetUrls,
          prompt:
            'Extrae todos los repuestos con precio visible y si existe stock/disponibilidad. Devuelve items únicos con URL de producto, nombre, precio, moneda, marca y SKU.',
          schema: PRODUCT_EXTRACTION_SCHEMA,
          enableWebSearch: false,
          maxItems: maxProductsPerSite,
          url,
        };

        const extracted = await this.scrapingService.runTask('extract', extractPayload);
        const extractedProducts = collectExtractedProducts(extracted.raw, extracted.provider, url);
        const mergedProducts = mergeProducts(extracted.normalizedProducts, extractedProducts);
        const inventory = this.inventoryStoreService.upsertSiteProducts(url, mergedProducts, runAt);

        return {
          site: url,
          pagesUsedForExtract: targetUrls.length,
          crawl: {
            provider: crawled.provider,
            requestedAt: crawled.requestedAt,
          },
          extract: {
            provider: extracted.provider,
            requestedAt: extracted.requestedAt,
            normalizedProducts: mergedProducts,
          },
          inventory,
        };
      }),
    );

    return {
      requestedAt: runAt,
      strategy: 'crawl + extract por dominio (Firecrawl-first)',
      sitesProcessed: urls.length,
      inventorySize: this.inventoryStoreService.getAll().length,
      results,
    };
  }

  startScrappingUy(request: CatalogScrapeRequestDto) {
    return this.scrapeCatalogWithPrices({
      ...request,
      urls: request.urls?.length ? request.urls : [...DEFAULT_CATALOG_SITES],
    });
  }

  getCurrentInventory(site?: string) {
    if (site) {
      return {
        site,
        total: this.inventoryStoreService.getBySite(site).length,
        products: this.inventoryStoreService.getBySite(site),
      };
    }

    const products = this.inventoryStoreService.getAll();

    return {
      total: products.length,
      products,
    };
  }

  buildExecutionPlan(request?: CatalogScrapeRequestDto) {
    const urls = request?.urls?.length ? request.urls : [...DEFAULT_CATALOG_SITES];

    return {
      strategy: 'hybrid-firecrawl-first',
      steps: [
        '1) Crawl por dominio para descubrir URLs de catálogo/producto.',
        '2) Extract en lote con schema estricto para devolver repuestos con precio.',
        '3) Upsert en inventario: si llega stock/disponibilidad se actualiza; si no llega, se conserva el dato guardado.',
        '4) Fallback por dominio y reintentos si cobertura es baja.',
      ],
      sites: urls,
      totalSites: urls.length,
    };
  }
}

function collectTargetUrls(raw: unknown, fallbackUrl: string, maxPages: number): string[] {
  const links = new Set<string>();

  const visit = (value: unknown) => {
    if (!value) {
      return;
    }

    if (typeof value === 'string') {
      if (value.startsWith('http://') || value.startsWith('https://')) {
        links.add(value);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(visit);
    }
  };

  visit(raw);

  const selected = Array.from(links).slice(0, maxPages);
  if (selected.length === 0) {
    selected.push(fallbackUrl);
  }

  return selected;
}

function collectExtractedProducts(raw: unknown, provider: 'firecrawl' | 'custom', sourceUrl: string): ProductRecord[] {
  const candidates: ProductRecord[] = [];

  const visit = (value: unknown) => {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    const record = value as Record<string, unknown>;
    if (Array.isArray(record.products)) {
      for (const product of record.products) {
        if (typeof product !== 'object' || !product) {
          continue;
        }

        const item = product as Record<string, unknown>;
        const name = asString(item.name);
        const price = asString(item.price);

        if (!name || !price) {
          continue;
        }

        candidates.push({
          productName: name,
          price,
          currency: asString(item.currency),
          brand: asString(item.brand),
          sku: asString(item.sku),
          stock: asString(item.stock),
          availability: asString(item.availability),
          sourceUrl: asString(item.productUrl) ?? sourceUrl,
          extractedAt: new Date().toISOString(),
          provider,
        });
      }
    }

    Object.values(record).forEach(visit);
  };

  visit(raw);
  return candidates;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function mergeProducts(base: ProductRecord[], incoming: ProductRecord[]): ProductRecord[] {
  const merged = new Map<string, ProductRecord>();

  for (const item of [...base, ...incoming]) {
    const key = `${item.sourceUrl ?? item.sku ?? `${item.productName ?? 'unknown'}|${item.brand ?? 'unknown'}`}`.toLowerCase();
    const previous = merged.get(key);

    if (!previous) {
      merged.set(key, item);
      continue;
    }

    merged.set(key, {
      ...previous,
      ...item,
      stock: item.stock ?? previous.stock,
      availability: item.availability ?? previous.availability,
    });
  }

  return Array.from(merged.values());
}
