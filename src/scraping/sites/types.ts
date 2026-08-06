import type { ProductRecord } from '../interfaces/scraping.types';

export type CatalogPlatform =
  | 'woocommerce'
  | 'shopify'
  | 'fenicio'
  | 'generic-html'
  | 'json-api'
  | 'mercado-libre-api';

export type CatalogAuthentication =
  | { type: 'none' }
  | { type: 'basic'; usernameEnv: string; passwordEnv: string }
  | { type: 'api-key'; headerName: string; tokenEnv: string }
  | {
      type: 'oauth';
      clientIdEnv: string;
      clientSecretEnv: string;
      refreshTokenEnv?: string;
      scopes?: string[];
    };

export type CatalogPaginationStrategy =
  | { type: 'none' }
  | { type: 'next-link'; selector?: string; maxPages?: number }
  | { type: 'page-param'; param: string; start?: number; maxPages?: number }
  | { type: 'path-page'; pattern?: string; start?: number; maxPages?: number }
  | { type: 'cursor'; param: string; maxPages?: number };

export interface CatalogSiteConfig {
  id: string;
  label: string;
  hostname: string;
  seedUrls: string[];
  platform: CatalogPlatform;
  authentication: CatalogAuthentication;
  productUrlPatterns: RegExp[];
  categoryUrlPatterns: RegExp[];
  paginationStrategy: CatalogPaginationStrategy;
  priceLocale: string;
  preserveOutOfStock: boolean;
  concurrency: number;
  requestDelay: number;
  enabled: boolean;
}

export interface CatalogHttpResponse {
  url: string;
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface CatalogRequestContext {
  site: CatalogSiteConfig;
  signal?: AbortSignal;
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<CatalogHttpResponse>;
}

export interface DiscoveryPageResult {
  listingUrl: string;
  pageUrl: string;
  pageNumber: number;
  productUrls: string[];
  categoryUrls: string[];
  nextPageUrl?: string;
  isLastPage?: boolean;
}

export interface DiscoveryResult {
  siteId: string;
  categories: string[];
  pages: DiscoveryPageResult[];
  discoveredUrls: string[];
  uniqueUrls: string[];
  duplicates: number;
  errors: CatalogPipelineError[];
}

export interface ExtractionResult {
  siteId: string;
  products: ProductRecord[];
  rejected: CatalogRejectedProduct[];
  errors: CatalogPipelineError[];
}

export interface NormalizationResult {
  products: ProductRecord[];
  duplicates: CatalogDuplicateProduct[];
}

export interface ValidationResult {
  products: ProductRecord[];
  rejected: CatalogRejectedProduct[];
}

export interface CatalogAuditReport {
  siteId: string;
  siteLabel: string;
  mode: CatalogRunMode;
  categories: number;
  pages: number;
  urlsDiscovered: number;
  urlsUnique: number;
  productsExtracted: number;
  productsValid: number;
  prices: number;
  sku: number;
  images: number;
  duplicates: number;
  rejected: number;
  errors: number;
  estimatedCoverage: number;
  outputPath?: string;
}

export interface CatalogPipelineError {
  phase: CatalogPipelinePhase;
  url?: string;
  message: string;
}

export interface CatalogRejectedProduct {
  url?: string;
  reason: string;
}

export interface CatalogDuplicateProduct {
  url?: string;
  duplicateOf?: string;
  reason: 'canonical_url' | 'sku' | 'name';
}

export type CatalogPipelinePhase = 'discovery' | 'extraction' | 'normalization' | 'validation' | 'persistence';
export type CatalogRunMode = 'discover' | 'probe' | 'audit' | 'run';

export interface CatalogAdapter {
  readonly platform: CatalogPlatform;
  discover(context: CatalogRequestContext): Promise<DiscoveryResult>;
  extract(context: CatalogRequestContext, urls: string[]): Promise<ExtractionResult>;
  normalize(site: CatalogSiteConfig, products: ProductRecord[]): NormalizationResult;
  validate(site: CatalogSiteConfig, products: ProductRecord[]): ValidationResult;
  persist?(site: CatalogSiteConfig, products: ProductRecord[], outputRoot?: string): Promise<{ outputPath: string }>;
}

export interface CatalogPipelineOptions {
  site: CatalogSiteConfig;
  mode: CatalogRunMode;
  maxPages?: number;
  maxProducts?: number;
  outputRoot?: string;
  signal?: AbortSignal;
}
