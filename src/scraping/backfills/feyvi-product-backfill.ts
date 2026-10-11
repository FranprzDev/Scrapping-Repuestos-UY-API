import { extractProductsFromHtml, validFeyviPrice } from '../domain/domain-html';
import { findDomainRule } from '../domain/domain-rules';
import { ProductRecord } from '../interfaces/scraping.types';

export const FEYVI_PRODUCT_URL_PATTERN = /^https?:\/\/(?:www\.)?feyvi\.com\.uy\/repuestos\/(?:[^/]+\/){2}[^/?#]+\/?$/i;

const INVALID_IMAGE_PATTERN = /(?:logo|favicon|placeholder|no-image|sin-imagen|loader|sprite|banner|promo|medios?[-_]?pago|visa|mastercard|whatsapp|facebook|instagram|abt__yt_mwi__icon|design\/themes|\/icons?\/)/i;
const PRODUCT_IMAGE_PATTERN = /\/images\/(?:thumbnails\/\d+\/\d+\/)?detailed\/.+\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i;

export interface FeyviBackfillRow {
  id: string;
  sourceUrl: string;
  product: ProductRecord;
}

export interface FeyviBackfillStore {
  findCandidates(limit?: number, afterId?: string): Promise<FeyviBackfillRow[]>;
  updateProductFields(id: string, product: ProductRecord, previous?: ProductRecord, runId?: string): Promise<void>;
  completedIds?(runId: string): Promise<string[]>;
  recordResult?(runId: string, item: FeyviProductBackfillItem, apply: boolean): Promise<void>;
}

export interface FeyviBackfillFetchResult {
  finalUrl: string;
  body: string;
  statusCode?: number;
}

export interface FeyviProductBackfillOptions {
  apply?: boolean;
  limit?: number;
  batchSize?: number;
  retries?: number;
  runId?: string;
  store: FeyviBackfillStore;
  fetchProductHtml: (sourceUrl: string) => Promise<FeyviBackfillFetchResult>;
}

export interface FeyviProductBackfillItem {
  id: string;
  productName?: string;
  sourceUrl: string;
  extractionWarnings?: string[];
  previousPrice?: string;
  newPrice?: string;
  previousSku?: string;
  newSku?: string;
  previousImageUrl?: string;
  newImageUrl?: string;
  previousBrand?: string;
  newBrand?: string;
  compatibleVehicles?: string[];
  wouldUpdate: boolean;
  applied: boolean;
  reason: string;
  error?: string;
}

export interface FeyviProductBackfillSummary {
  dryRun: boolean;
  limit?: number;
  totalCandidates: number;
  extracted: number;
  withValidPrice: number;
  withSku: number;
  priceExtractionFailures: number;
  priceUnavailable: number;
  withValidImage: number;
  withCompatibility: number;
  wouldUpdate: number;
  updated: number;
  errors: number;
  items: FeyviProductBackfillItem[];
}

export async function runFeyviProductBackfill(options: FeyviProductBackfillOptions): Promise<FeyviProductBackfillSummary> {
  const dryRun = options.apply !== true;
  const candidates: FeyviBackfillRow[] = [];
  const completed = new Set(options.runId && !dryRun ? await options.store.completedIds?.(options.runId) ?? [] : []);
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 1500));
  let afterId: string | undefined;
  let processed = 0;
  const items: FeyviProductBackfillItem[] = [];

  while (options.limit === undefined || processed < options.limit) {
    const batch = await options.store.findCandidates(Math.min(batchSize, (options.limit ?? Infinity) - processed), afterId);
    if (!batch.length) break;
    for (const row of batch) {
      if (completed.has(row.id)) continue;
      candidates.push(row);
      processed += 1;
      if (!isFeyviProductUrl(row.sourceUrl)) {
        items.push({
          id: row.id,
          productName: row.product.productName,
          sourceUrl: row.sourceUrl,
          previousImageUrl: row.product.imageUrl,
          previousBrand: row.product.brand,
          wouldUpdate: false,
          applied: false,
          reason: 'skipped_non_feyvi_product_url',
        });
        continue;
      }

      try {
        let response: FeyviBackfillFetchResult | undefined;
        for (let attempt = 0; attempt <= (options.retries ?? 2); attempt += 1) {
          try {
            response = await options.fetchProductHtml(row.sourceUrl);
            if (response.statusCode !== undefined && response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);
            break;
          } catch (error) {
            if (attempt >= (options.retries ?? 2) || !/429|5\d\d|ETIMEDOUT|ECONNRESET/.test(String(error))) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          }
        }
        if (!response || canonicalProductUrl(response.finalUrl) !== canonicalProductUrl(row.sourceUrl)) throw new Error('unexpected_product_redirect');
        const extracted = extractFeyviProduct(response.body, response.finalUrl, row.sourceUrl);
        if (row.product.sku?.trim() && extracted.sku && row.product.sku.trim() !== extracted.sku) {
          throw new Error('sku_mismatch_requires_review');
        }
        const nextProduct = buildProductWithUpdatedFeyviFields(row.product, extracted);
        const wouldUpdate = shouldUpdateFeyviFields(row.product, nextProduct);

        if (wouldUpdate && !dryRun) {
          await options.store.updateProductFields(row.id, nextProduct, row.product, options.runId);
        }

        items.push({
          id: row.id,
          productName: row.product.productName,
          sourceUrl: row.sourceUrl,
          previousImageUrl: row.product.imageUrl,
          extractionWarnings: extracted.qualityWarnings,
          previousPrice: row.product.price,
          newPrice: extracted.price,
          previousSku: row.product.sku,
          newSku: extracted.sku,
          newImageUrl: extracted.imageUrl,
          previousBrand: row.product.brand,
          newBrand: extracted.brand,
          compatibleVehicles: extracted.compatibleVehicles,
          wouldUpdate,
          applied: wouldUpdate && !dryRun,
          reason: reasonForResult(extracted, wouldUpdate, dryRun),
        });
      } catch (error) {
        items.push({
          id: row.id,
          productName: row.product.productName,
          sourceUrl: row.sourceUrl,
          previousImageUrl: row.product.imageUrl,
          previousBrand: row.product.brand,
          wouldUpdate: false,
          applied: false,
          reason: 'fetch_or_extract_error',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (options.runId && items.length) await options.store.recordResult?.(options.runId, items.at(-1)!, !dryRun);
    }
    const nextAfter = batch.at(-1)!.id;
    if (nextAfter === afterId) throw new Error('candidate_cursor_did_not_advance');
    afterId = nextAfter;
  }
  return summarizeBackfill(dryRun, options.limit, candidates.length, items);
}

export function isFeyviProductUrl(value: string | undefined): boolean {
  return Boolean(value && FEYVI_PRODUCT_URL_PATTERN.test(value));
}

export function isValidFeyviProductImageUrl(value: string | undefined): boolean {
  return Boolean(value && PRODUCT_IMAGE_PATTERN.test(value) && !INVALID_IMAGE_PATTERN.test(value));
}

export function extractFeyviProduct(html: string, finalUrl: string, sourceUrl: string): Partial<ProductRecord> {
  const rule = findDomainRule(sourceUrl);
  if (!rule) {
    return {};
  }

  const canonicalSourceUrl = canonicalProductUrl(sourceUrl);
  const products = extractProductsFromHtml(html, finalUrl, 'domain', rule);
  const product = products.find((item) => canonicalProductUrl(item.sourceUrl) === canonicalSourceUrl);
  if (!product) throw new Error('feyvi_detail_not_extracted');
  if (!product.sku && !product.price && !isValidFeyviProductImageUrl(product.imageUrl)) {
    throw new Error('feyvi_incomplete_or_blocked_detail');
  }
  const imageUrls = uniqueStrings(product?.imageUrls ?? (product?.imageUrl ? [product.imageUrl] : []))
    .filter(isValidFeyviProductImageUrl);

  return {
    price: validFeyviPrice(product.price),
    currency: product.price ? product.currency : undefined,
    sku: product.sku,
    productName: product.productName,
    description: product.description,
    availability: product.availability,
    qualityWarnings: product.qualityWarnings,
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    brand: product?.brand,
    compatibleBrands: product?.compatibleBrands,
    compatibleModels: product?.compatibleModels,
    compatibleVehicles: product?.compatibleVehicles,
    compatibleVersions: product?.compatibleVersions,
  };
}

function buildProductWithUpdatedFeyviFields(previous: ProductRecord, extracted: Partial<ProductRecord>): ProductRecord {
  return {
    ...previous,
    price: extracted.price ?? previous.price,
    currency: extracted.currency ?? previous.currency,
    sku: previous.sku?.trim() || extracted.sku,
    productName: extracted.productName ?? previous.productName,
    description: extracted.description ?? previous.description,
    availability: extracted.availability ?? previous.availability,
    imageUrl: previous.imageUrl && !INVALID_IMAGE_PATTERN.test(previous.imageUrl) ? previous.imageUrl : extracted.imageUrl ?? previous.imageUrl,
    imageUrls: mergeValues(previous.imageUrls?.filter((url) => !INVALID_IMAGE_PATTERN.test(url)), extracted.imageUrls),
    brand: extracted.brand ?? previous.brand,
    compatibleBrands: mergeValues(previous.compatibleBrands, extracted.compatibleBrands),
    compatibleModels: mergeValues(previous.compatibleModels, extracted.compatibleModels),
    compatibleVehicles: mergeValues(previous.compatibleVehicles, extracted.compatibleVehicles),
    compatibleVersions: mergeValues(previous.compatibleVersions, extracted.compatibleVersions),
  };
}

function shouldUpdateFeyviFields(previous: ProductRecord, next: ProductRecord): boolean {
  return previous.price !== next.price
    || previous.currency !== next.currency
    || previous.sku !== next.sku
    || previous.productName !== next.productName
    || previous.description !== next.description
    || previous.availability !== next.availability
    || previous.imageUrl !== next.imageUrl
    || JSON.stringify(previous.imageUrls ?? []) !== JSON.stringify(next.imageUrls ?? [])
    || previous.brand !== next.brand
    || JSON.stringify(previous.compatibleBrands ?? []) !== JSON.stringify(next.compatibleBrands ?? [])
    || JSON.stringify(previous.compatibleModels ?? []) !== JSON.stringify(next.compatibleModels ?? [])
    || JSON.stringify(previous.compatibleVehicles ?? []) !== JSON.stringify(next.compatibleVehicles ?? [])
    || JSON.stringify(previous.compatibleVersions ?? []) !== JSON.stringify(next.compatibleVersions ?? []);
}

function reasonForResult(extracted: Partial<ProductRecord>, wouldUpdate: boolean, dryRun: boolean): string {
  if (!extracted.price && !extracted.sku && !extracted.imageUrl && !extracted.brand && !extracted.compatibleVehicles?.length) {
    return 'no_feyvi_fields_extracted';
  }
  if (!wouldUpdate) {
    return 'already_current';
  }
  return dryRun ? 'dry_run_pending_update' : 'updated';
}

function summarizeBackfill(
  dryRun: boolean,
  limit: number | undefined,
  totalCandidates: number,
  items: FeyviProductBackfillItem[],
): FeyviProductBackfillSummary {
  return {
    dryRun,
    ...(limit !== undefined ? { limit } : {}),
    totalCandidates,
    extracted: items.filter((item) => !item.error && item.reason !== 'no_feyvi_fields_extracted' && item.reason !== 'skipped_non_feyvi_product_url').length,
    withValidPrice: items.filter((item) => validFeyviPrice(item.newPrice)).length,
    withSku: items.filter((item) => item.newSku).length,
    priceExtractionFailures: items.filter((item) => item.extractionWarnings?.includes('feyvi_price_extraction_failed')).length,
    priceUnavailable: items.filter((item) => item.extractionWarnings?.includes('feyvi_price_unavailable')).length,
    withValidImage: items.filter((item) => isValidFeyviProductImageUrl(item.newImageUrl)).length,
    withCompatibility: items.filter((item) => item.compatibleVehicles?.length).length,
    wouldUpdate: items.filter((item) => item.wouldUpdate).length,
    updated: items.filter((item) => item.applied).length,
    errors: items.filter((item) => item.error).length,
    items,
  };
}

function canonicalProductUrl(value?: string): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const url = new URL(value.trim());
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    url.pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function mergeValues(previous?: string[], current?: string[]): string[] | undefined {
  const values = uniqueStrings([...(previous ?? []), ...(current ?? [])].filter((value) => value.trim()));
  return values.length ? values : undefined;
}
