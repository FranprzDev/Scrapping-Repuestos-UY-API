import { extractProductsFromHtml } from '../domain/domain-html';
import { ProductRecord } from '../interfaces/scraping.types';
import { DomainRule } from '../domain/domain-rules';
import { getCatalogSite } from '../sites/catalog-sites';

export const REPUESTOS_AVENIDA_PRODUCT_URL_PREFIX = 'https://repuestosavenida.com.uy/producto/';

const INVALID_IMAGE_PATTERN = /(?:logo|favicon|brand|branding|placeholder|no-image|sin-imagen|header|footer|whatsapp)/i;

export interface RepuestosAvenidaBackfillRow {
  id: string;
  sourceUrl: string;
  product: ProductRecord;
}

export interface RepuestosAvenidaBackfillStore {
  findCandidates(limit?: number): Promise<RepuestosAvenidaBackfillRow[]>;
  updateImages(id: string, product: ProductRecord): Promise<void>;
}

export interface RepuestosAvenidaBackfillFetchResult {
  finalUrl: string;
  body: string;
}

export interface RepuestosAvenidaImageBackfillOptions {
  apply?: boolean;
  limit?: number;
  store: RepuestosAvenidaBackfillStore;
  fetchProductHtml: (sourceUrl: string) => Promise<RepuestosAvenidaBackfillFetchResult>;
}

export interface RepuestosAvenidaImageBackfillItem {
  id: string;
  productName?: string;
  sourceUrl: string;
  previousImageUrl?: string;
  newImageUrl?: string;
  previousImageInvalid: boolean;
  newImageValid: boolean;
  wouldUpdate: boolean;
  applied: boolean;
  error?: string;
}

export interface RepuestosAvenidaImageBackfillSummary {
  dryRun: boolean;
  limit?: number;
  totalCandidates: number;
  currentLogoOrPlaceholder: number;
  newValidImage: number;
  withoutValidImage: number;
  wouldUpdate: number;
  updated: number;
  errors: number;
  items: RepuestosAvenidaImageBackfillItem[];
}

export async function runRepuestosAvenidaImageBackfill(
  options: RepuestosAvenidaImageBackfillOptions,
): Promise<RepuestosAvenidaImageBackfillSummary> {
  const dryRun = options.apply !== true;
  const candidates = await options.store.findCandidates(options.limit);
  const items: RepuestosAvenidaImageBackfillItem[] = [];

  for (const row of candidates) {
    if (!isRepuestosAvenidaProductUrl(row.sourceUrl)) {
      items.push({
        id: row.id,
        productName: row.product.productName,
        sourceUrl: row.sourceUrl,
        previousImageUrl: row.product.imageUrl,
        previousImageInvalid: isInvalidImageUrl(row.product.imageUrl),
        newImageValid: false,
        wouldUpdate: false,
        applied: false,
        error: 'non_repuestos_avenida_source_url',
      });
      continue;
    }

    try {
      const response = await options.fetchProductHtml(row.sourceUrl);
      const extracted = extractRepuestosAvenidaProductImages(response.body, response.finalUrl, row.sourceUrl);
      const nextProduct = buildProductWithUpdatedImages(row.product, extracted);
      const previousImageInvalid = isInvalidImageUrl(row.product.imageUrl);
      const newImageValid = isValidImageUrl(extracted.imageUrl);
      const wouldUpdate = shouldUpdateImages(row.product, nextProduct, newImageValid);

      if (wouldUpdate && !dryRun) {
        await options.store.updateImages(row.id, nextProduct);
      }

      items.push({
        id: row.id,
        productName: row.product.productName,
        sourceUrl: row.sourceUrl,
        previousImageUrl: row.product.imageUrl,
        newImageUrl: extracted.imageUrl,
        previousImageInvalid,
        newImageValid,
        wouldUpdate,
        applied: wouldUpdate && !dryRun,
      });
    } catch (error) {
      items.push({
        id: row.id,
        productName: row.product.productName,
        sourceUrl: row.sourceUrl,
        previousImageUrl: row.product.imageUrl,
        previousImageInvalid: isInvalidImageUrl(row.product.imageUrl),
        newImageValid: false,
        wouldUpdate: false,
        applied: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summarizeBackfill(dryRun, options.limit, candidates.length, items);
}

export function isRepuestosAvenidaProductUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:'
      && url.hostname.replace(/^www\./, '').toLowerCase() === 'repuestosavenida.com.uy'
      && url.pathname.toLowerCase().startsWith('/producto/')
    );
  } catch {
    return false;
  }
}

export function isInvalidImageUrl(value: string | undefined): boolean {
  return Boolean(value && INVALID_IMAGE_PATTERN.test(value));
}

export function isValidImageUrl(value: string | undefined): boolean {
  return Boolean(value && !isInvalidImageUrl(value));
}

function extractRepuestosAvenidaProductImages(
  html: string,
  finalUrl: string,
  sourceUrl: string,
): Pick<ProductRecord, 'imageUrl' | 'imageUrls'> {
  const rule = getRepuestosAvenidaDomainRule();
  if (!rule) {
    return {};
  }

  const canonicalSourceUrl = canonicalProductUrl(sourceUrl);
  const product = extractProductsFromHtml(html, finalUrl, 'domain', rule)
    .find((item) => canonicalProductUrl(item.sourceUrl) === canonicalSourceUrl);

  const imageUrls = uniqueStrings(product?.imageUrls ?? (product?.imageUrl ? [product.imageUrl] : []))
    .filter(isValidImageUrl);

  return {
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
  };
}

function buildProductWithUpdatedImages(
  previous: ProductRecord,
  images: Pick<ProductRecord, 'imageUrl' | 'imageUrls'>,
): ProductRecord {
  const { imageUrl, imageUrls } = images;
  return {
    ...previous,
    imageUrl,
    imageUrls,
  };
}

function shouldUpdateImages(previous: ProductRecord, next: ProductRecord, newImageValid: boolean): boolean {
  if (!newImageValid) {
    return false;
  }

  return previous.imageUrl !== next.imageUrl
    || JSON.stringify(previous.imageUrls ?? []) !== JSON.stringify(next.imageUrls ?? []);
}

function summarizeBackfill(
  dryRun: boolean,
  limit: number | undefined,
  totalCandidates: number,
  items: RepuestosAvenidaImageBackfillItem[],
): RepuestosAvenidaImageBackfillSummary {
  return {
    dryRun,
    ...(limit !== undefined ? { limit } : {}),
    totalCandidates,
    currentLogoOrPlaceholder: items.filter((item) => item.previousImageInvalid).length,
    newValidImage: items.filter((item) => item.newImageValid).length,
    withoutValidImage: items.filter((item) => !item.newImageValid && !item.error).length,
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

function getRepuestosAvenidaDomainRule(): DomainRule | undefined {
  const site = getCatalogSite('repuestosavenida');
  if (!site) {
    return undefined;
  }

  return {
    id: site.id,
    hostnames: [site.hostname, `www.${site.hostname}`],
    seedUrls: site.seedUrls,
    preferredMethod: 'http',
    preserveOutOfStock: site.preserveOutOfStock,
    productUrlPatterns: site.productUrlPatterns,
    categoryUrlPatterns: site.categoryUrlPatterns,
    excludeUrlPatterns: [/\/(?:cart|carrito|checkout|mi-cuenta|account|login|contacto|blog)(?:\/|\?|$)/i],
    positiveAvailabilityTexts: ['comprar', 'agregar al carrito', 'anadir al carrito', 'en stock', 'disponible'],
    negativeAvailabilityTexts: ['agotado', 'sin stock', 'out of stock', 'no disponible'],
  };
}
