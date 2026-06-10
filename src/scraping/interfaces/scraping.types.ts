export type ScrapingTask = 'scrape' | 'crawl' | 'extract' | 'catalog-run';

export type ProviderName = 'domain' | 'playwright' | 'custom';

export type ScrapingOperationPayload = Record<string, unknown>;

export interface SiteMetadataRecord {
  site: string;
  shipping: string[];
  pickups: string[];
  contact: string[];
  faq: string[];
  policies: string[];
  discoveredAt: string;
}

export interface ProductRecord {
  productName?: string;
  price?: string;
  currency?: string;
  brand?: string;
  sku?: string;
  category?: string;
  description?: string;
  availability?: string;
  stock?: string;
  sourceUrl?: string;
  imageUrl?: string;
  imagePath?: string;
  compatibleVehicles?: string[];
  compatibleBrands?: string[];
  shippingInfo?: string[];
  attributes?: Record<string, string>;
  qualityWarnings?: string[];
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
