import { ArchiveStoreService } from './archive/archive-store.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CatalogScrapeRequestDto, DEFAULT_CATALOG_SITES, SingleSiteCatalogScrapeRequestDto } from './dto/catalog-request.dto';
import { ProductRecord, ProviderName, ScrapingOperationPayload } from './interfaces/scraping.types';
import { findDomainRule } from './domain/domain-rules';
import { countQualityWarnings, qualityGate } from './domain/product-quality';
import { InventoryStoreService } from './inventory/inventory-store.service';
import { PostgresService } from './jobs/postgres.service';
import { ScrapingService } from './scraping.service';
import { randomUUID } from 'node:crypto';

@Injectable()
export class CatalogScrapingService {
  private readonly logger = new Logger(CatalogScrapingService.name);

  constructor(
    @Inject(ScrapingService)
    private readonly scrapingService: ScrapingService,
    @Inject(InventoryStoreService)
    private readonly inventoryStoreService: InventoryStoreService,
    @Inject(ArchiveStoreService)
    private readonly archiveStoreService: ArchiveStoreService,
    @Inject(PostgresService)
    private readonly postgresService: PostgresService,
  ) {}

  async scrapeCatalogWithPrices(request: CatalogScrapeRequestDto) {
    const urls = request.urls?.length ? request.urls : [...DEFAULT_CATALOG_SITES];
    const maxPagesPerSite = request.maxPagesPerSite ?? 1000000;
    const maxProductsPerSite = request.maxProductsPerSite ?? 1000000;
    const siteConcurrency = request.siteConcurrency ?? 2;
    const runAt = new Date().toISOString();
    const runId = randomUUID();
    const startedAt = Date.now();
    this.logger.log(`[run:${runId}] started sites=${urls.length} siteConcurrency=${siteConcurrency}`);

    const results = await runWithConcurrency(urls, siteConcurrency, async (url) => {
      const siteStartedAt = Date.now();
      this.logger.log(`[run:${runId}] site_started site=${url}`);
      try {
        const crawlPayload: ScrapingOperationPayload = {
          url,
          limit: maxPagesPerSite,
          formats: ['links', 'products'],
          onlyMainContent: true,
        };

        const crawled = await this.scrapingService.runTask('crawl', crawlPayload);
        const targetUrls = collectTargetUrls(crawled.raw, url, maxProductsPerSite);

        const extractPayload: ScrapingOperationPayload = {
          urls: targetUrls,
          maxItems: maxProductsPerSite,
          url,
        };

        const extracted = await this.scrapingService.runTask('extract', extractPayload);
        const extractedProducts = collectExtractedProducts(extracted.raw, extracted.provider, url);
        const rule = findDomainRule(url);
        const mergedProducts = qualityGate(mergeProducts(extracted.normalizedProducts, extractedProducts), rule);
        const trace = buildSiteTrace(crawled.raw, extracted.raw, extractedProducts, mergedProducts);
        const archived = await this.archiveStoreService.saveSiteCatalog(url, mergedProducts, runAt, trace);
        const inventory = await this.inventoryStoreService.upsertSiteProducts(url, archived.products, runAt);
        this.logger.log(
          `[run:${runId}] site_done site=${url} status=success products=${mergedProducts.length} durationMs=${Date.now() - siteStartedAt}`,
        );

        return {
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
            warnings: countQualityWarnings(mergedProducts),
          },
          archive: {
            outputPath: archived.outputPath,
            imagesSaved: archived.imagesSaved,
          },
          trace,
          inventory,
        };
      } catch (error) {
        this.logger.warn(
          `[run:${runId}] site_done site=${url} status=error durationMs=${Date.now() - siteStartedAt} message=${formatSiteError(error)}`,
        );
        return {
          site: url,
          status: 'error',
          message: formatSiteError(error),
        };
      }
    });

    const inventorySize = await this.inventoryStoreService.countAll();
    const strategy = 'descubrimiento por dominio + extraccion hibrida (HTTP/API con fallback Playwright)';

    await this.saveRun(runId, runAt, strategy, urls.length, inventorySize, results);
    this.logger.log(`[run:${runId}] completed sites=${urls.length} inventorySize=${inventorySize} durationMs=${Date.now() - startedAt}`);

    return {
      runId,
      requestedAt: runAt,
      strategy,
      sitesProcessed: urls.length,
      inventorySize,
      results,
    };
  }

  refreshCatalogInventory() {
    return this.scrapeCatalogWithPrices({
      urls: [...DEFAULT_CATALOG_SITES],
    });
  }

  async scrapeSingleSiteAndReturnInventory(request: SingleSiteCatalogScrapeRequestDto) {
    await this.scrapeCatalogWithPrices({
      urls: [request.url],
      maxPagesPerSite: request.maxPages,
      maxProductsPerSite: request.maxProducts,
    });

    return await this.getCurrentInventory(request.url);
  }

  startScrappingUy(request: CatalogScrapeRequestDto) {
    void request;
    return this.refreshCatalogInventory();
  }

  async getCurrentInventory(site?: string) {
    if (site) {
      const products = await this.inventoryStoreService.getBySite(site);
      return {
        site,
        total: products.length,
        products,
      };
    }

    const products = await this.inventoryStoreService.getAll();

    return {
      total: products.length,
      products,
    };
  }

  async listRuns(limit = 20) {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const runs = await this.postgresService.query<{
      id: string;
      requested_at: string;
      strategy: string;
      sites_processed: number;
      inventory_size: number;
      summary: { results?: unknown[] };
    }>(
      `
      SELECT id, requested_at, strategy, sites_processed, inventory_size, summary
      FROM scraping_runs
      ORDER BY requested_at DESC
      LIMIT $1
      `,
      [safeLimit],
    );

    return {
      total: runs.rows.length,
      runs: runs.rows.map((row) => ({
        runId: row.id,
        requestedAt: row.requested_at,
        strategy: row.strategy,
        sitesProcessed: row.sites_processed,
        inventorySize: row.inventory_size,
        resultsCount: Array.isArray(row.summary?.results) ? row.summary.results.length : 0,
      })),
    };
  }

  async getRunById(runId: string) {
    const run = await this.postgresService.query<{
      id: string;
      requested_at: string;
      strategy: string;
      sites_processed: number;
      inventory_size: number;
      summary: { results?: unknown[] };
    }>(
      `
      SELECT id, requested_at, strategy, sites_processed, inventory_size, summary
      FROM scraping_runs
      WHERE id = $1::uuid
      `,
      [runId],
    );

    const [runRow] = run.rows;
    if (!runRow) {
      return undefined;
    }

    const sites = await this.postgresService.query<{
      site: string;
      status: string;
      payload: Record<string, unknown>;
    }>(
      `
      SELECT site, status, payload
      FROM scraping_run_sites
      WHERE run_id = $1::uuid
      ORDER BY site ASC
      `,
      [runId],
    );

    return {
      runId: runRow.id,
      requestedAt: runRow.requested_at,
      strategy: runRow.strategy,
      sitesProcessed: runRow.sites_processed,
      inventorySize: runRow.inventory_size,
      summary: runRow.summary,
      sites: sites.rows.map((site) => ({
        site: site.site,
        status: site.status,
        trace: typeof site.payload.trace === 'object' ? site.payload.trace : undefined,
        payload: site.payload,
      })),
    };
  }

  private async saveRun(
    runId: string,
    runAt: string,
    strategy: string,
    sitesProcessed: number,
    inventorySize: number,
    results: unknown[],
  ) {
    await this.postgresService.ensureCatalogTables();
    await this.postgresService.query(
      `
      INSERT INTO scraping_runs (id, requested_at, strategy, sites_processed, inventory_size, summary)
      VALUES ($1::uuid, $2::timestamptz, $3, $4, $5, $6::jsonb)
      `,
      [runId, runAt, strategy, sitesProcessed, inventorySize, JSON.stringify({ results })],
    );

    for (const item of results) {
      const record = item as Record<string, unknown>;
      const site = typeof record.site === 'string' ? record.site : 'unknown';
      const status = typeof record.status === 'string' ? record.status : 'unknown';
      await this.postgresService.query(
        `
        INSERT INTO scraping_run_sites (run_id, site, status, payload)
        VALUES ($1::uuid, $2, $3, $4::jsonb)
        ON CONFLICT (run_id, site) DO UPDATE
        SET status = EXCLUDED.status,
            payload = EXCLUDED.payload
        `,
        [runId, site, status, JSON.stringify(record)],
      );
    }
  }
}

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(safeLimit, items.length) }, async () => {
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

function formatSiteError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function collectTargetUrls(raw: unknown, fallbackUrl: string, maxProducts: number): string[] {
  if (typeof raw === 'object' && raw && Array.isArray((raw as { discoveredUrls?: unknown[] }).discoveredUrls)) {
    const discovered = (raw as { discoveredUrls: unknown[] }).discoveredUrls
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .slice(0, maxProducts);

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

  const selected = prioritizeUrls(Array.from(links), fallback, maxProducts);
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

function buildSiteTrace(
  crawlRaw: unknown,
  extractRaw: unknown,
  extractedProducts: ProductRecord[],
  mergedProducts: ProductRecord[],
) {
  const crawl = crawlRaw as { pages?: unknown[]; discoveredUrls?: unknown[]; discoveryMethod?: string } | undefined;
  const extract = extractRaw as { pages?: unknown[]; urls?: unknown[] } | undefined;
  return {
    crawl: {
      discoveryMethod: crawl?.discoveryMethod ?? 'unknown',
      pagesDiscovered: Array.isArray(crawl?.pages) ? crawl?.pages.length : 0,
      urlsDiscovered: Array.isArray(crawl?.discoveredUrls) ? crawl?.discoveredUrls.length : 0,
    },
    extract: {
      pagesProcessed: Array.isArray(extract?.pages) ? extract?.pages.length : 0,
      urlsRequested: Array.isArray(extract?.urls) ? extract?.urls.length : 0,
      rawProducts: extractedProducts.length,
      mergedProducts: mergedProducts.length,
    },
  };
}
