import type { ProductRecord } from '../interfaces/scraping.types';
import {
  authenticateYokomitsuHttpSession,
  isYokomitsuSessionExpiredResponse,
  type YokomitsuCredentials,
  type YokomitsuHttpClient,
  type YokomitsuHttpResponse,
} from './yokomitsu-auth';
import {
  extractYokomitsuProductDetailFromHtml,
  parseYokomitsuSearchResponseFull,
  YOKOMITSU_BASE_URL,
  YOKOMITSU_SEARCH_ENDPOINT,
  type YokomitsuSearchRequest,
} from './yokomitsu';

export const YOKOMITSU_FULL_REGISTER = 12;
export const YOKOMITSU_FULL_VIEW = 'grid';

export interface YokomitsuFullScrapeOptions {
  credentials: YokomitsuCredentials;
  outputProduct?: (product: ProductRecord) => Promise<void>;
  checkpoint?: YokomitsuFullCheckpoint;
  onCheckpoint?: (checkpoint: YokomitsuFullCheckpoint) => Promise<void>;
  onProgress?: (progress: YokomitsuFullProgress) => void;
  register?: number;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  now?: () => string;
}

export interface YokomitsuFullProgress {
  pagesProcessed: number;
  totalPages?: number;
  urlsDiscovered: number;
  productsProcessed: number;
  validProducts: number;
  duplicates: number;
  errors: number;
  sessionRenewed: boolean;
  elapsedMs: number;
}

export interface YokomitsuFullCheckpoint {
  version: 1;
  discoveryMethod?: YokomitsuDiscoveryMethod;
  completedPages: string[];
  discoveredProducts: Array<{ sourceUrl?: string; sku?: string }>;
  processedProductKeys: string[];
  counters: {
    pagesProcessed: number;
    productsProcessed: number;
    validProducts: number;
    duplicates: number;
    errors: number;
  };
  updatedAt: string;
}

export type YokomitsuDiscoveryMethod = 'empty-search-global';

export interface YokomitsuFullScrapeResult {
  discoveryMethod?: YokomitsuDiscoveryMethod;
  emptySearchReturnedGlobalCatalog: boolean;
  totalResults?: number;
  pageSize: number;
  totalPages?: number;
  pagesProcessed: number;
  urlsDiscovered: number;
  productsProcessed: number;
  validProducts: number;
  duplicates: number;
  errors: number;
  sessionRenewed: boolean;
  checkpoint: YokomitsuFullCheckpoint;
  limitations: string[];
}

interface DiscoveredProduct {
  key: string;
  listing: ProductRecord;
}

interface CatalogPage {
  page: number;
  response: YokomitsuHttpResponse;
}

export function createEmptyYokomitsuCheckpoint(now = new Date().toISOString()): YokomitsuFullCheckpoint {
  return {
    version: 1,
    completedPages: [],
    discoveredProducts: [],
    processedProductKeys: [],
    counters: {
      pagesProcessed: 0,
      productsProcessed: 0,
      validProducts: 0,
      duplicates: 0,
      errors: 0,
    },
    updatedAt: now,
  };
}

export function buildYokomitsuCatalogSearchBody(input: Partial<YokomitsuSearchRequest> = {}): string {
  return new URLSearchParams({
    id_category: input.id_category ?? '',
    id_subcategory: input.id_subcategory ?? '',
    id_subsubcategory: input.id_subsubcategory ?? '',
    option_filter: input.option_filter ?? '',
    search: input.search ?? '',
    order: input.order ?? '',
    register: String(input.register ?? YOKOMITSU_FULL_REGISTER),
    page: String(input.page ?? 1),
    view: input.view ?? YOKOMITSU_FULL_VIEW,
  }).toString();
}

export function calculateYokomitsuTotalPages(totalResults: number | undefined, pageSize: number): number | undefined {
  return totalResults && pageSize > 0 ? Math.ceil(totalResults / pageSize) : undefined;
}

export function yokomitsuProductDedupKey(product: ProductRecord): string | undefined {
  const canonicalUrl = canonicalYokomitsuUrl(product.sourceUrl);
  if (canonicalUrl) return `url:${canonicalUrl}`;
  if (product.sku) return `sku:${product.sku.trim().toUpperCase()}`;
  return undefined;
}

export function sanitizeYokomitsuCheckpoint(checkpoint: YokomitsuFullCheckpoint): YokomitsuFullCheckpoint {
  return {
    version: 1,
    discoveryMethod: checkpoint.discoveryMethod,
    completedPages: Array.from(new Set(checkpoint.completedPages)).sort(),
    discoveredProducts: sanitizeDiscoveredProducts(checkpoint.discoveredProducts ?? []),
    processedProductKeys: Array.from(new Set(checkpoint.processedProductKeys))
      .filter((key) => !/cookie|authorization|password|auth_token|token|rut|YOKOMITSU_FRONT=/i.test(key))
      .sort(),
    counters: { ...checkpoint.counters },
    updatedAt: checkpoint.updatedAt,
  };
}

export async function runYokomitsuFullCatalog(
  client: YokomitsuHttpClient,
  options: YokomitsuFullScrapeOptions,
): Promise<YokomitsuFullScrapeResult> {
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date().toISOString());
  const checkpoint = sanitizeYokomitsuCheckpoint(options.checkpoint ?? createEmptyYokomitsuCheckpoint(now()));
  const completedPages = new Set(checkpoint.completedPages);
  const processedKeys = new Set(checkpoint.processedProductKeys);
  const discoveredKeys = new Set<string>();
  const discoveredUrls = new Set<string>();
  const discoveredSkus = new Set<string>();
  const discoveredProducts: DiscoveredProduct[] = hydrateDiscoveredProducts(checkpoint);
  for (const product of discoveredProducts) {
    discoveredKeys.add(product.key);
    const canonicalUrl = canonicalYokomitsuUrl(product.listing.sourceUrl);
    if (canonicalUrl) discoveredUrls.add(`url:${canonicalUrl}`);
    if (product.listing.sku) discoveredSkus.add(`sku:${product.listing.sku.trim().toUpperCase()}`);
  }
  const pageSize = options.register ?? YOKOMITSU_FULL_REGISTER;
  const concurrency = clampInteger(options.concurrency ?? 3, 1, 4);
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 750;
  const limitations: string[] = [];
  let sessionRenewed = false;
  let loginAttempts = 0;

  const login = async () => {
    loginAttempts += 1;
    const result = await authenticateYokomitsuHttpSession(client, options.credentials);
    if (!result.authenticated) throw new Error(result.error ?? 'Yokomitsu login failed');
  };

  const postCatalog = async (page: number): Promise<YokomitsuHttpResponse> => {
    const body = buildYokomitsuCatalogSearchBody({ page, register: pageSize, view: YOKOMITSU_FULL_VIEW, search: '' });
    return requestWithRetry(async () => client.post(YOKOMITSU_SEARCH_ENDPOINT, body, {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
    }), {
      retries,
      retryDelayMs,
      isRetryable: (response) => response.status === 429 || response.status >= 500,
    });
  };

  const getDetail = async (url: string): Promise<YokomitsuHttpResponse> => requestWithRetry(
    async () => client.get(url, { accept: 'text/html,application/xhtml+xml' }),
    {
      retries,
      retryDelayMs,
      isRetryable: (response) => response.status === 429 || response.status >= 500,
    },
  );

  const catalogWithSession = async (page: number): Promise<CatalogPage> => {
    let response = await postCatalog(page);
    if (isYokomitsuSessionExpiredResponse(response) && !sessionRenewed) {
      sessionRenewed = true;
      await login();
      response = await postCatalog(page);
    }
    if (isYokomitsuSessionExpiredResponse(response)) throw new Error('Yokomitsu session expired during catalog pagination');
    return { page, response };
  };

  const detailWithSession = async (url: string): Promise<YokomitsuHttpResponse> => {
    let response = await getDetail(url);
    if (isYokomitsuSessionExpiredResponse(response) && !sessionRenewed) {
      sessionRenewed = true;
      await login();
      response = await getDetail(url);
    }
    if (isYokomitsuSessionExpiredResponse(response)) throw new Error('Yokomitsu session expired during product detail fetch');
    return response;
  };

  await login();
  const firstPage = await catalogWithSession(1);
  const firstSummary = parseYokomitsuSearchResponseFull(firstPage.response.body, { page: 1, register: pageSize, view: YOKOMITSU_FULL_VIEW }, YOKOMITSU_BASE_URL);
  if (!firstSummary || !firstSummary.numberRegister || firstSummary.numberRegister <= 0) {
    limitations.push('empty search did not return a global catalog; category discovery is required before full coverage');
    return finalize();
  }

  checkpoint.discoveryMethod = 'empty-search-global';
  const totalResults = firstSummary.numberRegister;
  const totalPages = calculateYokomitsuTotalPages(totalResults, pageSize);
  collectProducts(firstSummary.products);
  await markPageCompleted('empty:1');

  const pageNumbers = Array.from({ length: Math.max((totalPages ?? 1) - 1, 0) }, (_, index) => index + 2)
    .filter((page) => !completedPages.has(`empty:${page}`));
  for (const page of pageNumbers) {
    const pageResult = await catalogWithSession(page);
    const summary = parseYokomitsuSearchResponseFull(pageResult.response.body, { page, register: pageSize, view: YOKOMITSU_FULL_VIEW }, YOKOMITSU_BASE_URL);
    if (!summary) {
      checkpoint.counters.errors += 1;
      continue;
    }
    if (summary.products.length === 0) {
      await markPageCompleted(`empty:${page}`);
      break;
    }
    collectProducts(summary.products);
    await markPageCompleted(`empty:${page}`);
  }

  await runPool(discoveredProducts, concurrency, async (entry) => {
    if (processedKeys.has(entry.key)) {
      checkpoint.counters.duplicates += 1;
      return;
    }
    try {
      const sourceUrl = entry.listing.sourceUrl;
      const detail = sourceUrl ? await detailWithSession(sourceUrl) : undefined;
      const detailProduct = detail && sourceUrl
        ? extractYokomitsuProductDetailFromHtml(detail.body, sourceUrl, YOKOMITSU_BASE_URL)
        : undefined;
      const product = mergeYokomitsuProduct(entry.listing, detailProduct);
      checkpoint.counters.productsProcessed += 1;
      if (isValidYokomitsuProduct(product)) {
        checkpoint.counters.validProducts += 1;
        await options.outputProduct?.(product);
      } else {
        checkpoint.counters.errors += 1;
      }
      processedKeys.add(entry.key);
      checkpoint.processedProductKeys = Array.from(processedKeys);
      await saveCheckpoint();
      reportProgress(totalPages, startedAt, discoveredKeys.size, sessionRenewed, options.onProgress, checkpoint);
    } catch {
      checkpoint.counters.errors += 1;
      await saveCheckpoint();
    }
  });

  return finalize(totalResults, totalPages);

  function collectProducts(products: ProductRecord[]): void {
    for (const product of products) {
      const key = yokomitsuProductDedupKey(product);
      if (!key) {
        checkpoint.counters.errors += 1;
        continue;
      }
      const canonicalUrl = canonicalYokomitsuUrl(product.sourceUrl);
      const urlKey = canonicalUrl ? `url:${canonicalUrl}` : undefined;
      const skuKey = product.sku ? `sku:${product.sku.trim().toUpperCase()}` : undefined;
      if (discoveredKeys.has(key)
        || (urlKey && discoveredUrls.has(urlKey))
        || (skuKey && discoveredSkus.has(skuKey))) {
        checkpoint.counters.duplicates += 1;
        continue;
      }
      discoveredKeys.add(key);
      if (urlKey) discoveredUrls.add(urlKey);
      if (skuKey) discoveredSkus.add(skuKey);
      discoveredProducts.push({ key, listing: product });
      checkpoint.discoveredProducts = sanitizeDiscoveredProducts([
        ...(checkpoint.discoveredProducts ?? []),
        { sourceUrl: product.sourceUrl, sku: product.sku },
      ]);
    }
  }

  async function markPageCompleted(key: string): Promise<void> {
    if (!completedPages.has(key)) {
      completedPages.add(key);
      checkpoint.completedPages = Array.from(completedPages);
      checkpoint.counters.pagesProcessed += 1;
      await saveCheckpoint();
      reportProgress(totalPages, startedAt, discoveredKeys.size, sessionRenewed, options.onProgress, checkpoint);
    }
  }

  async function saveCheckpoint(): Promise<void> {
    checkpoint.updatedAt = now();
    await options.onCheckpoint?.(sanitizeYokomitsuCheckpoint(checkpoint));
  }

  function finalize(totalResults?: number, totalPages?: number): YokomitsuFullScrapeResult {
    const safeCheckpoint = sanitizeYokomitsuCheckpoint(checkpoint);
    return {
      discoveryMethod: checkpoint.discoveryMethod,
      emptySearchReturnedGlobalCatalog: checkpoint.discoveryMethod === 'empty-search-global',
      totalResults,
      pageSize,
      totalPages,
      pagesProcessed: safeCheckpoint.counters.pagesProcessed,
      urlsDiscovered: discoveredKeys.size,
      productsProcessed: safeCheckpoint.counters.productsProcessed,
      validProducts: safeCheckpoint.counters.validProducts,
      duplicates: safeCheckpoint.counters.duplicates,
      errors: safeCheckpoint.counters.errors,
      sessionRenewed,
      checkpoint: safeCheckpoint,
      limitations,
    };
  }
}

async function requestWithRetry(
  request: () => Promise<YokomitsuHttpResponse>,
  options: { retries: number; retryDelayMs: number; isRetryable: (response: YokomitsuHttpResponse) => boolean },
): Promise<YokomitsuHttpResponse> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= options.retries) {
    try {
      const response = await request();
      if (!options.isRetryable(response) || attempt === options.retries) return response;
    } catch (error) {
      lastError = error;
      if (attempt === options.retries) throw error;
    }
    attempt += 1;
    await delay(options.retryDelayMs * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error('Yokomitsu request failed');
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function mergeYokomitsuProduct(listing: ProductRecord, detail?: ProductRecord): ProductRecord {
  if (!detail) return listing;
  return {
    ...listing,
    ...detail,
    attributes: {
      ...(listing.attributes ?? {}),
      ...(detail.attributes ?? {}),
    },
    imageUrls: uniqueStrings([...(listing.imageUrls ?? []), listing.imageUrl, ...(detail.imageUrls ?? []), detail.imageUrl]),
    imageUrl: detail.imageUrl ?? listing.imageUrl,
    sourceUrl: detail.sourceUrl ?? listing.sourceUrl,
    provider: 'Yokomitsu',
    extractedAt: detail.extractedAt || listing.extractedAt,
  };
}

function isValidYokomitsuProduct(product: ProductRecord): boolean {
  return Boolean(product.sourceUrl || product.sku) && Boolean(product.productName || product.sku);
}

function canonicalYokomitsuUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function reportProgress(
  totalPages: number | undefined,
  startedAt: number,
  urlsDiscovered: number,
  sessionRenewed: boolean,
  onProgress: ((progress: YokomitsuFullProgress) => void) | undefined,
  checkpoint: YokomitsuFullCheckpoint,
): void {
  onProgress?.({
    pagesProcessed: checkpoint.counters.pagesProcessed,
    totalPages,
    urlsDiscovered,
    productsProcessed: checkpoint.counters.productsProcessed,
    validProducts: checkpoint.counters.validProducts,
    duplicates: checkpoint.counters.duplicates,
    errors: checkpoint.counters.errors,
    sessionRenewed,
    elapsedMs: Date.now() - startedAt,
  });
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function uniqueStrings(values: Array<string | undefined>): string[] | undefined {
  const unique = Array.from(new Set(values.filter((value): value is string => Boolean(value))));
  return unique.length > 0 ? unique : undefined;
}

function hydrateDiscoveredProducts(checkpoint: YokomitsuFullCheckpoint): DiscoveredProduct[] {
  return sanitizeDiscoveredProducts(checkpoint.discoveredProducts ?? [])
    .map((ref) => {
      const listing: ProductRecord = {
        sourceUrl: ref.sourceUrl,
        sku: ref.sku,
        provider: 'Yokomitsu',
        extractedAt: checkpoint.updatedAt,
      };
      const key = yokomitsuProductDedupKey(listing);
      return key ? { key, listing } : undefined;
    })
    .filter((value): value is DiscoveredProduct => Boolean(value));
}

function sanitizeDiscoveredProducts(values: Array<{ sourceUrl?: string; sku?: string }>): Array<{ sourceUrl?: string; sku?: string }> {
  const seen = new Set<string>();
  const safe: Array<{ sourceUrl?: string; sku?: string }> = [];
  for (const value of values) {
    const sourceUrl = canonicalYokomitsuUrl(value.sourceUrl);
    const sku = value.sku?.trim();
    if (!sourceUrl && !sku) continue;
    if ([sourceUrl, sku].filter(Boolean).join(' ').match(/cookie|authorization|password|auth_token|token|rut|YOKOMITSU_FRONT=/i)) continue;
    const key = sourceUrl ? `url:${sourceUrl}` : `sku:${sku?.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push({ sourceUrl, sku });
  }
  return safe;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
