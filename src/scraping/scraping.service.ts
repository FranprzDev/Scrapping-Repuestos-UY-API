import { Injectable } from '@nestjs/common';
import { CrawlRequestDto, ExtractRequestDto, ScrapeRequestDto } from './dto/scrape-request.dto';
import { ProviderResult, ScrapingOperationPayload, ScrapingProvider, ScrapingTask } from './interfaces/scraping.types';
import { CustomProvider } from './providers/custom.provider';
import { PlaywrightProvider } from './providers/playwright.provider';

@Injectable()
export class ScrapingService {
  private readonly providers: Record<string, ScrapingProvider>;
  private readonly customDomains = new Set(
    (process.env.CUSTOM_PROVIDER_DOMAINS ?? '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
  );

  constructor(
    private readonly playwrightProvider: PlaywrightProvider,
    private readonly customProvider: CustomProvider,
  ) {
    this.providers = {
      [this.playwrightProvider.name]: this.playwrightProvider,
      [this.customProvider.name]: this.customProvider,
    };
  }

  scrape(payload: ScrapeRequestDto, providerOverride?: string) {
    return this.runTask('scrape', { url: payload.url }, providerOverride);
  }

  crawl(payload: CrawlRequestDto, providerOverride?: string) {
    const crawlPayload = {
      ...payload,
      scrapeOptions: {
        formats: payload.formats,
        onlyMainContent: payload.onlyMainContent,
        waitFor: payload.waitFor,
      },
    };

    return this.runTask('crawl', crawlPayload, providerOverride);
  }

  extract(payload: ExtractRequestDto, providerOverride?: string) {
    const extractPayload: ScrapingOperationPayload = {
      urls: [payload.url],
      prompt: payload.prompt,
      schema: payload.schema,
      url: payload.url,
    };

    return this.runTask('extract', extractPayload, providerOverride);
  }

  runTask(task: ScrapingTask, payload: ScrapingOperationPayload, providerOverride?: string): Promise<ProviderResult> {
    const provider = this.pickProvider(payload, providerOverride);
    return provider.run(task, payload);
  }

  private pickProvider(payload: ScrapingOperationPayload, providerOverride?: string): ScrapingProvider {
    if (providerOverride && this.providers[providerOverride]) {
      return this.providers[providerOverride];
    }

    const sourceUrl = typeof payload.url === 'string' ? payload.url : undefined;
    if (!sourceUrl) {
      return this.playwrightProvider;
    }

    const hostname = safeHostname(sourceUrl);
    if (hostname && this.customDomains.has(hostname)) {
      return this.customProvider;
    }

    return this.playwrightProvider;
  }
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
