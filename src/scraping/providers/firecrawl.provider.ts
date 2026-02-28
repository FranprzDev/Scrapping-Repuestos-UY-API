import { HttpException, HttpStatus, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ProviderResult, ScrapingOperationPayload, ScrapingProvider, ScrapingTask } from '../interfaces/scraping.types';
import { normalizeToProducts } from './normalizer';

type FirecrawlResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

@Injectable()
export class FirecrawlProvider implements ScrapingProvider {
  readonly name = 'firecrawl' as const;
  private readonly firecrawlApiBase = process.env.FIRECRAWL_API_BASE_URL ?? 'https://api.firecrawl.dev/v1';

  async run(task: ScrapingTask, payload: ScrapingOperationPayload): Promise<ProviderResult> {
    const endpoint = this.resolveEndpoint(task);
    const raw = await this.request(endpoint, payload);
    const sourceUrl = typeof payload.url === 'string' ? payload.url : undefined;

    return {
      provider: this.name,
      task,
      requestedAt: new Date().toISOString(),
      sourceUrl,
      raw,
      normalizedProducts: normalizeToProducts(raw, this.name, sourceUrl),
    };
  }

  private resolveEndpoint(task: ScrapingTask): string {
    if (task === 'scrape') {
      return '/scrape';
    }

    if (task === 'crawl') {
      return '/crawl';
    }

    return '/extract';
  }

  private async request(path: string, body: ScrapingOperationPayload): Promise<unknown> {
    const apiKey = process.env.FIRECRAWL_API_KEY;

    if (!apiKey) {
      throw new InternalServerErrorException('FIRECRAWL_API_KEY no está configurada.');
    }

    const response = await fetch(`${this.firecrawlApiBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(cleanBody(body)),
    });

    const json = (await response.json()) as FirecrawlResponse<unknown>;

    if (!response.ok || !json.success) {
      throw new HttpException(
        {
          message: 'Firecrawl devolvió un error al procesar la operación.',
          firecrawlError: json.error,
        },
        response.status || HttpStatus.BAD_GATEWAY,
      );
    }

    return json.data;
  }
}

function cleanBody(body: ScrapingOperationPayload) {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}
