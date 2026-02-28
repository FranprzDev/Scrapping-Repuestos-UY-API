import { Module } from '@nestjs/common';
import { CatalogScrapingService } from './scraping/catalog-scraping.service';
import { InventoryStoreService } from './scraping/inventory/inventory-store.service';
import { JobQueueService } from './scraping/jobs/job.queue';
import { CustomProvider } from './scraping/providers/custom.provider';
import { FirecrawlProvider } from './scraping/providers/firecrawl.provider';
import { ScrapingController } from './scraping/scraping.controller';
import { ScrapingService } from './scraping/scraping.service';

@Module({
  imports: [],
  controllers: [ScrapingController],
  providers: [ScrapingService, CatalogScrapingService, InventoryStoreService, FirecrawlProvider, CustomProvider, JobQueueService],
})
export class AppModule {}
