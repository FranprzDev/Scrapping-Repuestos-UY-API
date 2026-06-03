import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CatalogScrapingService } from './catalog-scraping.service';

@Injectable()
export class ScrapingSchedulerService {
  private readonly logger = new Logger(ScrapingSchedulerService.name);
  private isRunning = false;

  constructor(@Inject(CatalogScrapingService) private readonly catalogScrapingService: CatalogScrapingService) {}

  @Cron(process.env.SCRAPE_CRON ?? '0 0 3 * * *', {
    name: 'daily-catalog-scrape',
    timeZone: process.env.SCRAPE_TIMEZONE ?? 'America/Argentina/Buenos_Aires',
  })
  async runDailyCatalogScrape() {
    const enabled = (process.env.AUTO_SCRAPE_ENABLED ?? 'false').toLowerCase() === 'true';
    if (!enabled) {
      return;
    }

    if (this.isRunning) {
      this.logger.warn('daily-catalog-scrape skipped: previous run still in progress');
      return;
    }

    this.isRunning = true;
    const startedAt = Date.now();
    this.logger.log('daily-catalog-scrape started');

    try {
      const result = await this.catalogScrapingService.scrapeCatalogWithPrices({});
      this.logger.log(
        `daily-catalog-scrape completed runId=${result.runId} sites=${result.sitesProcessed} inventorySize=${result.inventorySize} durationMs=${Date.now() - startedAt}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`daily-catalog-scrape failed durationMs=${Date.now() - startedAt} message=${message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
