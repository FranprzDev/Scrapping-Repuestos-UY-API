import { Injectable } from '@nestjs/common';
import { ProviderResult, ScrapingOperationPayload, ScrapingProvider, ScrapingTask } from '../interfaces/scraping.types';
import { normalizeToProducts } from './normalizer';

@Injectable()
export class CustomProvider implements ScrapingProvider {
  readonly name = 'custom' as const;

  async run(task: ScrapingTask, payload: ScrapingOperationPayload): Promise<ProviderResult> {
    const sourceUrl = typeof payload.url === 'string' ? payload.url : undefined;
    const raw = await this.fetchHtml(sourceUrl);

    return {
      provider: this.name,
      task,
      requestedAt: new Date().toISOString(),
      sourceUrl,
      raw,
      normalizedProducts: normalizeToProducts(raw, this.name, sourceUrl),
    };
  }

  private async fetchHtml(sourceUrl?: string): Promise<unknown> {
    if (!sourceUrl) {
      return {
        warning: 'CustomProvider requiere `url` para operar.',
      };
    }

    const response = await fetch(sourceUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Scrapping-Repuestos-UY-API/1.0 (+custom-provider)',
      },
    });

    const html = await response.text();

    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      html,
    };
  }
}
