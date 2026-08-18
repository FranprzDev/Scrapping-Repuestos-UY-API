import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InventoryStoreService } from './inventory/inventory-store.service';
import { getCatalogSite } from './sites/catalog-sites';
import { runCatalogPipeline } from './sites/catalog-pipeline';

const DEFAULT_PRODUCTION_SITE_IDS = [
  'repuestosavenida',
  'autopartesgil',
  'autopartesmagallanes',
];

@Injectable()
export class ScrapingSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(ScrapingSchedulerService.name);
  private isRunning = false;

  constructor(
    @Inject(InventoryStoreService)
    private readonly inventoryStoreService: InventoryStoreService,
  ) {}

  onModuleInit() {
    const runOnStart = (process.env.AUTO_SCRAPE_ON_START ?? 'false').toLowerCase() === 'true';
    if (runOnStart) {
      setImmediate(() => void this.runProductionCatalogScrape('startup'));
    }
  }

  @Cron(process.env.SCRAPE_CRON ?? '0 0 3 * * *', {
    name: 'daily-catalog-scrape',
    timeZone: process.env.SCRAPE_TIMEZONE ?? 'America/Argentina/Buenos_Aires',
  })
  async runDailyCatalogScrape() {
    const enabled = (process.env.AUTO_SCRAPE_ENABLED ?? 'false').toLowerCase() === 'true';
    if (!enabled) {
      return;
    }

    await this.runProductionCatalogScrape('cron');
  }

  private async runProductionCatalogScrape(trigger: 'startup' | 'cron') {
    if (this.isRunning) {
      this.logger.warn(`production-catalog-scrape skipped trigger=${trigger}: previous run still in progress`);
      return;
    }

    this.isRunning = true;
    const startedAt = Date.now();
    const runAt = new Date().toISOString();
    const siteIds = parseProductionSiteIds(process.env.PRODUCTION_CATALOG_SITE_IDS);
    const maxPages = positiveIntegerOrUndefined(process.env.PRODUCTION_CATALOG_MAX_PAGES);
    const maxProducts = positiveIntegerOrUndefined(process.env.PRODUCTION_CATALOG_MAX_PRODUCTS);
    this.logger.log(`production-catalog-scrape started trigger=${trigger} sites=${siteIds.join(',')}`);

    try {
      for (const siteId of siteIds) {
        const site = getCatalogSite(siteId);
        if (!site?.enabled) {
          this.logger.warn(`production-catalog-scrape skipped unknown_or_disabled_site=${siteId}`);
          continue;
        }

        try {
          const report = await runCatalogPipeline({
            site,
            mode: 'run',
            maxPages,
            maxProducts,
            persistProducts: async (catalogSite, products) => {
              await this.inventoryStoreService.upsertSiteProducts(
                catalogSite.seedUrls[0] ?? `https://${catalogSite.hostname}/`,
                products,
                runAt,
              );
            },
          });
          this.logger.log(
            `production-catalog-site completed site=${site.id} products=${report.productsValid} prices=${report.prices} images=${report.images} errors=${report.errors}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`production-catalog-site failed site=${site.id} message=${message}`);
        }
      }

      this.logger.log(`production-catalog-scrape completed trigger=${trigger} durationMs=${Date.now() - startedAt}`);
    } finally {
      this.isRunning = false;
    }
  }
}

function parseProductionSiteIds(raw: string | undefined): string[] {
  const values = (raw ?? DEFAULT_PRODUCTION_SITE_IDS.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}

function positiveIntegerOrUndefined(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
