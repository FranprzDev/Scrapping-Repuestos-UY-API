export type ScrapingTask = 'scrape' | 'crawl' | 'extract';

export type ProviderName = 'firecrawl' | 'custom';

export type ScrapingOperationPayload = Record<string, unknown>;

export interface ProductRecord {
  productName?: string;
  price?: string;
  currency?: string;
  brand?: string;
  sku?: string;
  availability?: string;
  stock?: string;
  sourceUrl?: string;
  extractedAt: string;
  provider: ProviderName;
}

export interface ProviderResult {
  provider: ProviderName;
  requestedAt: string;
  task: ScrapingTask;
  sourceUrl?: string;
  raw: unknown;
  normalizedProducts: ProductRecord[];
}

export interface ScrapingProvider {
  readonly name: ProviderName;
  run(task: ScrapingTask, payload: ScrapingOperationPayload): Promise<ProviderResult>;
}
