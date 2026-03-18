import { Module } from '@nestjs/common';
import { ArchiveStoreService } from './scraping/archive/archive-store.service';
import { CatalogScrapingService } from './scraping/catalog-scraping.service';
import { InventoryStoreService } from './scraping/inventory/inventory-store.service';
import { JobQueueService } from './scraping/jobs/job.queue';
import { CustomProvider } from './scraping/providers/custom.provider';
import { DomainProvider } from './scraping/providers/domain.provider';
import { PlaywrightProvider } from './scraping/providers/playwright.provider';
import { ScrapingController } from './scraping/scraping.controller';
import { ScrapingService } from './scraping/scraping.service';

@Module({
  imports: [],
  controllers: [ScrapingController],
  providers: [ScrapingService, CatalogScrapingService, InventoryStoreService, ArchiveStoreService, PlaywrightProvider, DomainProvider, CustomProvider, JobQueueService],
})
export class AppModule {}
