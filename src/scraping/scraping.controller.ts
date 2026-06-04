import { Body, Controller, Get, Header, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CatalogScrapeRequestDto, SingleSiteCatalogScrapeRequestDto } from './dto/catalog-request.dto';
import { CrawlRequestDto, DomainProviderConfigDto, ExtractRequestDto, JobIdParamDto, ScrapeRequestDto } from './dto/scrape-request.dto';
import { CatalogScrapingService } from './catalog-scraping.service';
import { JobQueueService } from './jobs/job.queue';
import { ScrapingService } from './scraping.service';

@Controller()
export class ScrapingController {
  constructor(
    @Inject(ScrapingService)
    private readonly scrapingService: ScrapingService,
    @Inject(JobQueueService)
    private readonly jobQueueService: JobQueueService,
    @Inject(CatalogScrapingService)
    private readonly catalogScrapingService: CatalogScrapingService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  home() {
    return renderHomePage();
  }

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

  @Post('scraping/inventory/refresh')
  refreshInventory() {
    return this.catalogScrapingService.refreshCatalogInventory();
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

function renderHomePage(): string {
  return /* html */ `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>Scrapping-Repuestos-UY-API</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg: #09090f;
        --bg-card: rgba(15, 16, 23, 0.88);
        --line: rgba(255, 255, 255, 0.09);
        --text: #f4f0e8;
        --muted: rgba(244, 240, 232, 0.72);
        --accent: #e3b14a;
        --accent-2: #7ad7c1;
        --shadow: 0 28px 90px rgba(0, 0, 0, 0.55);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        margin: 0;
        min-height: 100%;
      }

      body {
        font-family: 'Manrope', system-ui, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(227, 177, 74, 0.18), transparent 32%),
          radial-gradient(circle at 85% 15%, rgba(122, 215, 193, 0.13), transparent 30%),
          radial-gradient(circle at 50% 90%, rgba(255, 127, 80, 0.12), transparent 28%),
          linear-gradient(160deg, #05050a 0%, #0a0a12 56%, #11111a 100%);
        overflow-x: hidden;
      }

      body::before {
        content: '';
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
        background-size: 48px 48px;
        mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.8), transparent 92%);
      }

      .shell {
        position: relative;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 32px;
      }

      .panel {
        width: min(1120px, 100%);
        border: 1px solid var(--line);
        border-radius: 28px;
        background: linear-gradient(180deg, rgba(18, 20, 29, 0.94), rgba(10, 11, 16, 0.94));
        box-shadow: var(--shadow);
        overflow: hidden;
        position: relative;
      }

      .hero {
        padding: 34px 34px 28px;
        display: grid;
        gap: 22px;
        border-bottom: 1px solid var(--line);
        background:
          linear-gradient(135deg, rgba(227, 177, 74, 0.08), transparent 34%),
          linear-gradient(225deg, rgba(122, 215, 193, 0.07), transparent 28%);
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: var(--accent-2);
        letter-spacing: 0.16em;
        text-transform: uppercase;
        font-size: 0.74rem;
        font-weight: 800;
      }

      .eyebrow::before {
        content: '';
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--accent);
        box-shadow: 0 0 0 6px rgba(227, 177, 74, 0.12);
      }

      h1 {
        margin: 0;
        font-family: 'Fraunces', Georgia, serif;
        font-size: clamp(2.6rem, 5vw, 4.8rem);
        line-height: 0.95;
        letter-spacing: -0.05em;
        max-width: 10ch;
      }

      .lede {
        margin: 0;
        max-width: 68ch;
        color: var(--muted);
        font-size: 1.05rem;
        line-height: 1.8;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }

      .button,
      .button-secondary,
      .button-ghost {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        border-radius: 999px;
        text-decoration: none;
        font-weight: 800;
        padding: 14px 18px;
        border: 1px solid transparent;
        transition:
          transform 180ms ease,
          border-color 180ms ease,
          background 180ms ease,
          color 180ms ease;
      }

      .button {
        color: #1a1406;
        background: linear-gradient(135deg, var(--accent), #f4d78c);
        box-shadow: 0 16px 32px rgba(227, 177, 74, 0.22);
      }

      .button-secondary {
        color: var(--text);
        background: rgba(255, 255, 255, 0.03);
        border-color: var(--line);
      }

      .button-ghost {
        color: var(--muted);
        background: transparent;
        border-color: transparent;
      }

      .button:hover,
      .button-secondary:hover,
      .button-ghost:hover {
        transform: translateY(-1px);
      }

      .grid {
        display: grid;
        grid-template-columns: 1.3fr 0.9fr;
        gap: 20px;
        padding: 24px 34px 34px;
      }

      .card {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: var(--bg-card);
        padding: 20px;
      }

      .card h2 {
        margin: 0 0 12px;
        font-size: 0.96rem;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: var(--accent-2);
      }

      .list {
        margin: 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 12px;
      }

      .endpoint {
        display: grid;
        gap: 6px;
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .endpoint strong {
        font-size: 0.98rem;
      }

      .endpoint code {
        color: var(--accent);
        font-size: 0.9rem;
        word-break: break-word;
      }

      .endpoint span {
        color: var(--muted);
        font-size: 0.92rem;
        line-height: 1.6;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .stat {
        padding: 18px;
        border-radius: 18px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02));
        border: 1px solid rgba(255, 255, 255, 0.08);
      }

      .stat .label {
        display: block;
        color: var(--muted);
        font-size: 0.82rem;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        margin-bottom: 10px;
      }

      .stat .value {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 1.55rem;
        line-height: 1;
        letter-spacing: -0.03em;
      }

      .note {
        margin-top: 16px;
        color: var(--muted);
        font-size: 0.92rem;
        line-height: 1.7;
      }

      @media (max-width: 900px) {
        .grid {
          grid-template-columns: 1fr;
        }

        .hero,
        .grid {
          padding-left: 20px;
          padding-right: 20px;
        }
      }

      @media (max-width: 640px) {
        .shell {
          padding: 16px;
        }

        .panel {
          border-radius: 22px;
        }

        .hero {
          padding-top: 26px;
          padding-bottom: 20px;
        }

        h1 {
          max-width: 100%;
        }

        .stats {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="panel">
        <header class="hero">
          <div class="eyebrow">Scrapping-Repuestos-UY-API</div>
          <h1>Inventory scraping with a clean operational surface.</h1>
          <p class="lede">
            This service runs the product catalog pipeline, stores inventory in PostgreSQL, and exposes a focused API for
            refresh, inspection, and scheduling. The inventory refresh flow now uses the active validated catalog sites by default.
          </p>
          <div class="actions">
            <a class="button" href="/health">Health check</a>
            <a class="button-secondary" href="/scraping/inventory">View inventory</a>
            <a class="button-ghost" href="/scraping/runs">Recent runs</a>
          </div>
        </header>

        <div class="grid">
          <section class="card">
            <h2>Refresh flow</h2>
            <div class="list">
              <div class="endpoint">
                <strong>Full inventory refresh</strong>
                <code>POST /scraping/inventory/refresh</code>
                <span>Runs all active catalog sites that are currently considered valid for production refreshes.</span>
              </div>
              <div class="endpoint">
                <strong>Legacy alias</strong>
                <code>POST /start-scrapping-uy</code>
                <span>Kept for compatibility. It now triggers the same full refresh path.</span>
              </div>
              <div class="endpoint">
                <strong>Custom run</strong>
                <code>POST /scraping/catalog/run</code>
                <span>Use this when you want to pass a custom URL list and override the default catalog scope.</span>
              </div>
            </div>
          </section>

          <section class="card">
            <h2>Platform</h2>
            <div class="stats">
              <div class="stat">
                <span class="label">Transport</span>
                <div class="value">NestJS</div>
              </div>
              <div class="stat">
                <span class="label">Storage</span>
                <div class="value">Postgres</div>
              </div>
              <div class="stat">
                <span class="label">Validated set</span>
                <div class="value">4 sites</div>
              </div>
              <div class="stat">
                <span class="label">Refresh mode</span>
                <div class="value">Full batch</div>
              </div>
            </div>
            <p class="note">
              The UI should now feel less generic, with a stronger editorial contrast and clearer operational calls to action.
              Taxitor remains the first confirmed baseline in the refresh flow.
            </p>
          </section>
        </div>
      </section>
    </main>
  </body>
</html>`;
}
