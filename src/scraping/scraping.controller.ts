import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CatalogScrapeRequestDto, SingleSiteCatalogScrapeRequestDto } from './dto/catalog-request.dto';
import { CrawlRequestDto, DomainProviderConfigDto, ExtractRequestDto, JobIdParamDto, ScrapeRequestDto } from './dto/scrape-request.dto';
import { JobQueueService } from './jobs/job.queue';
import { CatalogScrapingService } from './catalog-scraping.service';
import { ScrapingService } from './scraping.service';

@Controller()
export class ScrapingController {
  constructor(
    private readonly scrapingService: ScrapingService,
    private readonly jobQueueService: JobQueueService,
    private readonly catalogScrapingService: CatalogScrapingService,
  ) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'Scrapping-Repuestos-UY-API',
      mode: 'hybrid-provider',
    };
  }

  @Post('scraping/scrape')
  async scrape(@Body() payload: ScrapeRequestDto, @Query() config: DomainProviderConfigDto) {
    if (config.async === 'true') {
      return this.jobQueueService.enqueue('scrape', {
        ...payload,
        providerOverride: config.provider,
      });
    }

    return this.scrapingService.scrape(payload, config.provider);
  }

  @Post('scraping/crawl')
  async crawl(@Body() payload: CrawlRequestDto, @Query() config: DomainProviderConfigDto) {
    if (config.async === 'true') {
      return this.jobQueueService.enqueue('crawl', {
        ...payload,
        providerOverride: config.provider,
      });
    }

    return this.scrapingService.crawl(payload, config.provider);
  }

  @Post('scraping/extract')
  async extract(@Body() payload: ExtractRequestDto, @Query() config: DomainProviderConfigDto) {
    if (config.async === 'true') {
      return this.jobQueueService.enqueue('extract', {
        ...payload,
        providerOverride: config.provider,
      });
    }

    return this.scrapingService.extract(payload, config.provider);
  }

  @Post('scraping/catalog/run')
  runCatalog(@Body() payload: CatalogScrapeRequestDto) {
    return this.catalogScrapingService.scrapeCatalogWithPrices(payload);
  }

  @Post('scraping/quick-run')
  quickRunSingleSite(@Body() payload: SingleSiteCatalogScrapeRequestDto) {
    return this.catalogScrapingService.scrapeSingleSiteAndReturnInventory(payload);
  }

  @Post('start-scrapping-uy')
  startScrappingUy(@Body() payload: CatalogScrapeRequestDto) {
    return this.catalogScrapingService.startScrappingUy(payload);
  }

  @Get('scraping/inventory')
  getInventory(@Query('site') site?: string) {
    return this.catalogScrapingService.getCurrentInventory(site);
  }

  @Get('scraping/runs')
  listRuns(@Query('limit') limit?: string) {
    const parsed = Number(limit);
    const normalized = Number.isFinite(parsed) ? parsed : undefined;
    return this.catalogScrapingService.listRuns(normalized);
  }

  @Get('scraping/runs/:runId')
  async getRunById(@Param('runId') runId: string) {
    const run = await this.catalogScrapingService.getRunById(runId);
    if (!run) {
      throw new NotFoundException('Run no encontrado');
    }

    return run;
  }

  @Get('scraping/jobs/:id')
  async getJob(@Param() params: JobIdParamDto) {
    const job = await this.jobQueueService.findById(params.id);

    if (!job) {
      throw new NotFoundException('Job no encontrado');
    }

    return job;
  }
}
