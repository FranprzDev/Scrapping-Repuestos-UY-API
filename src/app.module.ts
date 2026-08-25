import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ArchiveStoreService } from './scraping/archive/archive-store.service';
import { CatalogScrapingService } from './scraping/catalog-scraping.service';
import { InventoryStoreService } from './scraping/inventory/inventory-store.service';
import { JobQueueService } from './scraping/jobs/job.queue';
import { PostgresService } from './scraping/jobs/postgres.service';
import { CustomProvider } from './scraping/providers/custom.provider';
import { DomainProvider } from './scraping/providers/domain.provider';
import { PlaywrightProvider } from './scraping/providers/playwright.provider';
import { ScrapingController } from './scraping/scraping.controller';
import { ScrapingSchedulerService } from './scraping/scraping.scheduler';
import { ScrapingService } from './scraping/scraping.service';
import { ImageRelayController } from './image-relay/image-relay.controller';
import { ImageRelayService } from './image-relay/image-relay.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [ScrapingController, ImageRelayController],
  providers: [
    ScrapingService,
    CatalogScrapingService,
    InventoryStoreService,
    ArchiveStoreService,
    PlaywrightProvider,
    DomainProvider,
    CustomProvider,
    PostgresService,
    JobQueueService,
    ScrapingSchedulerService,
    ImageRelayService,
  ],
})
export class AppModule {}
