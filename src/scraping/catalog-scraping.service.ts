import { ArchiveStoreService } from './archive/archive-store.service';
import { Injectable } from '@nestjs/common';
import { CatalogScrapeRequestDto, DEFAULT_CATALOG_SITES, SingleSiteCatalogScrapeRequestDto } from './dto/catalog-request.dto';
import { ProductRecord, ProviderName, ScrapingOperationPayload } from './interfaces/scraping.types';
import { findDomainRule } from './domain/domain-rules';
import { qualityGate } from './domain/product-quality';
import { InventoryStoreService } from './inventory/inventory-store.service';
import { ScrapingService } from './scraping.service';

@Injectable()
export class CatalogScrapingService {
  constructor(
    private readonly scrapingService: ScrapingService,
    private readonly inventoryStoreService: InventoryStoreService,
    private readonly archiveStoreService: ArchiveStoreService,
  ) {}

  async scrapeCatalogWithPrices(request: CatalogScrapeRequestDto) {
    const urls = request.urls?.length ? request.urls : [...DEFAULT_CATALOG_SITES];
    const maxPagesPerSite = request.maxPagesPerSite ?? 30;
    const maxProductsPerSite = request.maxProductsPerSite ?? 150;
    const runAt = new Date().toISOString();

    const results = [];

    for (const url of urls) {
      try {
        const crawlPayload: ScrapingOperationPayload = {
          url,
          limit: maxPagesPerSite,
          formats: ['links', 'products'],
          onlyMainContent: true,
        };

        const crawled = await this.scrapingService.runTask('crawl', crawlPayload);
        const targetUrls = collectTargetUrls(crawled.raw, url, maxPagesPerSite);

        const extractPayload: ScrapingOperationPayload = {
          urls: targetUrls,
          maxItems: maxProductsPerSite,
          url,
        };

        const extracted = await this.scrapingService.runTask('extract', extractPayload);
        const extractedProducts = collectExtractedProducts(extracted.raw, extracted.provider, url);
        const rule = findDomainRule(url);
        const mergedProducts = qualityGate(mergeProducts(extracted.normalizedProducts, extractedProducts), rule);
        const archived = await this.archiveStoreService.saveSiteCatalog(url, mergedProducts, runAt);
        const inventory = this.inventoryStoreService.upsertSiteProducts(url, archived.products, runAt);

        results.push({
          site: url,
          status: 'success',
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
          archive: {
            outputPath: archived.outputPath,
            imagesSaved: archived.imagesSaved,
          },
          inventory,
        });
      } catch (error) {
        results.push({
          site: url,
          status: 'error',
          message: formatSiteError(error),
        });
      }
    }

    return {
      requestedAt: runAt,
      strategy: 'descubrimiento por dominio + extraccion hibrida (HTTP/API con fallback Playwright)',
      sitesProcessed: urls.length,
      inventorySize: this.inventoryStoreService.getAll().length,
      results,
    };
  }

  async scrapeSingleSiteAndReturnInventory(request: SingleSiteCatalogScrapeRequestDto) {
    await this.scrapeCatalogWithPrices({
      urls: [request.url],
      maxPagesPerSite: request.maxPages,
      maxProductsPerSite: request.maxProducts,
    });

    return this.getCurrentInventory(request.url);
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

}

function formatSiteError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function collectTargetUrls(raw: unknown, fallbackUrl: string, maxPages: number): string[] {
  if (typeof raw === 'object' && raw && Array.isArray((raw as { discoveredUrls?: unknown[] }).discoveredUrls)) {
    const discovered = (raw as { discoveredUrls: unknown[] }).discoveredUrls
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .slice(0, maxPages);

    if (discovered.length > 0) {
      return discovered;
    }
  }

  const links = new Set<string>();
  const fallback = safeParseUrl(fallbackUrl);

  const visit = (value: unknown) => {
    if (!value) {
      return;
    }

    if (typeof value === 'string') {
      const normalized = normalizeCandidateUrl(value, fallbackUrl);
      if (normalized) {
        links.add(normalized);
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

  const selected = prioritizeUrls(Array.from(links), fallback, maxPages);
  if (selected.length === 0) {
    selected.push(fallbackUrl);
  }

  return selected;
}

function safeParseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function normalizeCandidateUrl(candidate: string, baseUrl: string): string | undefined {
  const value = candidate.trim();
  if (!value) {
    return undefined;
  }

  const lowered = value.toLowerCase();
  if (
    lowered.startsWith('mailto:') ||
    lowered.startsWith('tel:') ||
    lowered.startsWith('javascript:') ||
    lowered.startsWith('#')
  ) {
    return undefined;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function prioritizeUrls(urls: string[], fallback: URL | undefined, maxPages: number): string[] {
  const sameHost = urls.filter((url) => isSameHost(url, fallback));
  const preferred = sameHost.filter((url) => isCatalogLike(url));
  const regular = sameHost.filter((url) => !isCatalogLike(url));
  const ranked = [...preferred, ...regular];

  if (ranked.length >= maxPages) {
    return ranked.slice(0, maxPages);
  }

  const offDomain = urls.filter((url) => !isSameHost(url, fallback));
  return [...ranked, ...offDomain].slice(0, maxPages);
}

function isSameHost(candidateUrl: string, fallback: URL | undefined): boolean {
  if (!fallback) {
    return true;
  }

  try {
    return new URL(candidateUrl).hostname === fallback.hostname;
  } catch {
    return false;
  }
}

function isCatalogLike(candidateUrl: string): boolean {
  const lowered = candidateUrl.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|svg|webp|css|js|pdf)(\?|#|$)/.test(lowered)) {
    return false;
  }

  const hints = ['producto', 'productos', 'repuesto', 'repuestos', 'catalog', 'categoria', 'shop', 'tienda'];
  return hints.some((hint) => lowered.includes(hint));
}

function collectExtractedProducts(raw: unknown, provider: ProviderName, sourceUrl: string): ProductRecord[] {
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
        const name = asString(item.name) ?? asString(item.productName);
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
          sourceUrl: asString(item.productUrl) ?? asString(item.sourceUrl) ?? sourceUrl,
          imageUrl: asString(item.imageUrl),
          imagePath: asString(item.imagePath),
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
