import { extractProductsFromHtml } from '../domain/domain-html';
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
  findCandidates(limit?: number): Promise<FeyviBackfillRow[]>;
  updateProductFields(id: string, product: ProductRecord): Promise<void>;
}

export interface FeyviBackfillFetchResult {
  finalUrl: string;
  body: string;
}

export interface FeyviProductBackfillOptions {
  apply?: boolean;
  limit?: number;
  store: FeyviBackfillStore;
  fetchProductHtml: (sourceUrl: string) => Promise<FeyviBackfillFetchResult>;
}

export interface FeyviProductBackfillItem {
  id: string;
  productName?: string;
  sourceUrl: string;
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
  withValidImage: number;
  withCompatibility: number;
  wouldUpdate: number;
  updated: number;
  errors: number;
  items: FeyviProductBackfillItem[];
}

export async function runFeyviProductBackfill(options: FeyviProductBackfillOptions): Promise<FeyviProductBackfillSummary> {
  const dryRun = options.apply !== true;
  const candidates = await options.store.findCandidates(options.limit);
  const items: FeyviProductBackfillItem[] = [];

  for (const row of candidates) {
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
      const response = await options.fetchProductHtml(row.sourceUrl);
      const extracted = extractFeyviProduct(response.body, response.finalUrl, row.sourceUrl);
      const nextProduct = buildProductWithUpdatedFeyviFields(row.product, extracted);
      const wouldUpdate = shouldUpdateFeyviFields(row.product, nextProduct);

      if (wouldUpdate && !dryRun) {
        await options.store.updateProductFields(row.id, nextProduct);
      }

      items.push({
        id: row.id,
        productName: row.product.productName,
        sourceUrl: row.sourceUrl,
        previousImageUrl: row.product.imageUrl,
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
  }

  return summarizeBackfill(dryRun, options.limit, candidates.length, items);
}

export function isFeyviProductUrl(value: string | undefined): boolean {
  return Boolean(value && FEYVI_PRODUCT_URL_PATTERN.test(value));
}

export function isValidFeyviProductImageUrl(value: string | undefined): boolean {
  return Boolean(value && PRODUCT_IMAGE_PATTERN.test(value) && !INVALID_IMAGE_PATTERN.test(value));
}

function extractFeyviProduct(html: string, finalUrl: string, sourceUrl: string): Partial<ProductRecord> {
  const rule = findDomainRule(sourceUrl);
  if (!rule) {
    return {};
  }

  const canonicalSourceUrl = canonicalProductUrl(sourceUrl);
  const products = extractProductsFromHtml(html, finalUrl, 'domain', rule);
  const product = products.find((item) => canonicalProductUrl(item.sourceUrl) === canonicalSourceUrl) ?? products[0];
  const imageUrls = uniqueStrings(product?.imageUrls ?? (product?.imageUrl ? [product.imageUrl] : []))
    .filter(isValidFeyviProductImageUrl);

  return {
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
    imageUrl: extracted.imageUrl ?? previous.imageUrl,
    imageUrls: extracted.imageUrls ?? previous.imageUrls,
    brand: extracted.brand ?? previous.brand,
    compatibleBrands: extracted.compatibleBrands ?? previous.compatibleBrands,
    compatibleModels: extracted.compatibleModels ?? previous.compatibleModels,
    compatibleVehicles: extracted.compatibleVehicles ?? previous.compatibleVehicles,
    compatibleVersions: extracted.compatibleVersions ?? previous.compatibleVersions,
  };
}

function shouldUpdateFeyviFields(previous: ProductRecord, next: ProductRecord): boolean {
  return previous.imageUrl !== next.imageUrl
    || JSON.stringify(previous.imageUrls ?? []) !== JSON.stringify(next.imageUrls ?? [])
    || previous.brand !== next.brand
    || JSON.stringify(previous.compatibleBrands ?? []) !== JSON.stringify(next.compatibleBrands ?? [])
    || JSON.stringify(previous.compatibleModels ?? []) !== JSON.stringify(next.compatibleModels ?? [])
    || JSON.stringify(previous.compatibleVehicles ?? []) !== JSON.stringify(next.compatibleVehicles ?? [])
    || JSON.stringify(previous.compatibleVersions ?? []) !== JSON.stringify(next.compatibleVersions ?? []);
}

function reasonForResult(extracted: Partial<ProductRecord>, wouldUpdate: boolean, dryRun: boolean): string {
  if (!extracted.imageUrl && !extracted.brand && !extracted.compatibleVehicles?.length) {
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
    extracted: items.filter((item) => !item.error && item.reason !== 'no_feyvi_fields_extracted').length,
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
