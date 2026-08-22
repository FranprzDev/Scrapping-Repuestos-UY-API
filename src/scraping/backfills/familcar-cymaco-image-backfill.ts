import { extractProductsFromHtml } from '../domain/domain-html';
import { DomainRule } from '../domain/domain-rules';
import { ProductRecord } from '../interfaces/scraping.types';
import { getCatalogSite } from '../sites/catalog-sites';

export type FamilcarCymacoSite = 'familcar' | 'cymaco';

export const FAMILCAR_CYMACO_PRODUCT_URL_PREFIXES = [
  'https://www.familcar.com/catalogo/',
  'https://familcar.com/catalogo/',
  'https://www.cymaco.com.uy/catalogo/',
  'https://cymaco.com.uy/catalogo/',
] as const;

export const FAMILCAR_CYMACO_PRODUCT_URL_PREFIXES_BY_SITE: Record<FamilcarCymacoSite, readonly string[]> = {
  familcar: [
    'https://www.familcar.com/catalogo/',
    'https://familcar.com/catalogo/',
  ],
  cymaco: [
    'https://www.cymaco.com.uy/catalogo/',
    'https://cymaco.com.uy/catalogo/',
  ],
};

const LOGO_SEGMENT_PATTERN = /(^|[/_.-])logo([/_.-]|$)/i;
const INVALID_IMAGE_PATTERN = /(?:logomarca|favicon|brand|branding|header|footer|banner|placeholder|no-image|sin-imagen|whatsapp|facebook|instagram|iconos?|icons?|cocarda|cocardas|descuentos?|promocion|promociones|promo|oferta|medios?[-_]?pago|creditoydebito|assets\/commerce)/i;
const PRODUCT_IMAGE_EXTENSION_PATTERN = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i;

export interface FamilcarCymacoBackfillRow {
  id: string;
  sourceUrl: string;
  product: ProductRecord;
}

export interface FamilcarCymacoBackfillStore {
  findCandidates(limit?: number, site?: FamilcarCymacoSite): Promise<FamilcarCymacoBackfillRow[]>;
  updateImages(id: string, product: ProductRecord): Promise<void>;
}

export interface FamilcarCymacoBackfillFetchResult {
  finalUrl: string;
  body: string;
}

export interface FamilcarCymacoImageBackfillOptions {
  apply?: boolean;
  limit?: number;
  site?: FamilcarCymacoSite;
  store: FamilcarCymacoBackfillStore;
  fetchProductHtml: (sourceUrl: string) => Promise<FamilcarCymacoBackfillFetchResult>;
}

export interface FamilcarCymacoImageBackfillItem {
  id: string;
  site?: FamilcarCymacoSite;
  productName?: string;
  sourceUrl: string;
  currentImageUrl?: string;
  newImageUrl?: string;
  currentImageInvalid: boolean;
  newImageValid: boolean;
  wouldUpdate: boolean;
  applied: boolean;
  reason: string;
  error?: string;
}

export interface FamilcarCymacoImageBackfillSummary {
  dryRun: boolean;
  limit?: number;
  site?: FamilcarCymacoSite;
  totalCandidates: number;
  currentLogoOrPlaceholder: number;
  newValidImage: number;
  withoutValidImage: number;
  wouldUpdate: number;
  updated: number;
  errors: number;
  items: FamilcarCymacoImageBackfillItem[];
}

export async function runFamilcarCymacoImageBackfill(
  options: FamilcarCymacoImageBackfillOptions,
): Promise<FamilcarCymacoImageBackfillSummary> {
  assertValidFamilcarCymacoSite(options.site);

  const dryRun = options.apply !== true;
  const candidates = await options.store.findCandidates(options.limit, options.site);
  const items: FamilcarCymacoImageBackfillItem[] = [];

  for (const row of candidates) {
    const site = identifyFamilcarCymacoSourceUrl(row.sourceUrl);
    if (!site) {
      items.push({
        id: row.id,
        productName: row.product.productName,
        sourceUrl: row.sourceUrl,
        currentImageUrl: row.product.imageUrl,
        currentImageInvalid: isInvalidFamilcarCymacoImageUrl(row.product.imageUrl),
        newImageValid: false,
        wouldUpdate: false,
        applied: false,
        reason: 'skipped_non_familcar_cymaco_source_url',
      });
      continue;
    }

    try {
      const response = await options.fetchProductHtml(row.sourceUrl);
      const extracted = extractFamilcarCymacoProductImages(response.body, response.finalUrl, row.sourceUrl, site);
      const nextProduct = buildProductWithUpdatedImages(row.product, extracted);
      const currentImageInvalid = isInvalidFamilcarCymacoImageUrl(row.product.imageUrl);
      const newImageValid = isValidFamilcarCymacoImageUrl(extracted.imageUrl);
      const wouldUpdate = shouldUpdateImages(row.product, nextProduct, newImageValid);

      if (wouldUpdate && !dryRun) {
        await options.store.updateImages(row.id, nextProduct);
      }

      items.push({
        id: row.id,
        site,
        productName: row.product.productName,
        sourceUrl: row.sourceUrl,
        currentImageUrl: row.product.imageUrl,
        newImageUrl: extracted.imageUrl,
        currentImageInvalid,
        newImageValid,
        wouldUpdate,
        applied: wouldUpdate && !dryRun,
        reason: reasonForResult(wouldUpdate, newImageValid, dryRun),
      });
    } catch (error) {
      items.push({
        id: row.id,
        site,
        productName: row.product.productName,
        sourceUrl: row.sourceUrl,
        currentImageUrl: row.product.imageUrl,
        currentImageInvalid: isInvalidFamilcarCymacoImageUrl(row.product.imageUrl),
        newImageValid: false,
        wouldUpdate: false,
        applied: false,
        reason: 'fetch_or_extract_error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summarizeBackfill(dryRun, options.limit, options.site, candidates.length, items);
}

export function parseFamilcarCymacoBackfillSite(value: string | undefined): FamilcarCymacoSite | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'familcar' || value === 'cymaco') {
    return value;
  }

  throw new Error(`Invalid --site value "${value}". Expected "familcar" or "cymaco".`);
}

export function identifyFamilcarCymacoSourceUrl(value: string | undefined): FamilcarCymacoSite | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.pathname.toLowerCase().startsWith('/catalogo/')) {
      return undefined;
    }

    const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    if (hostname === 'familcar.com') {
      return 'familcar';
    }

    if (hostname === 'cymaco.com.uy') {
      return 'cymaco';
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function isInvalidFamilcarCymacoImageUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return LOGO_SEGMENT_PATTERN.test(normalized) || INVALID_IMAGE_PATTERN.test(normalized);
}

export function isValidFamilcarCymacoImageUrl(value: string | undefined): boolean {
  return Boolean(value && PRODUCT_IMAGE_EXTENSION_PATTERN.test(value) && !isInvalidFamilcarCymacoImageUrl(value));
}

function extractFamilcarCymacoProductImages(
  html: string,
  finalUrl: string,
  sourceUrl: string,
  site: FamilcarCymacoSite,
): Pick<ProductRecord, 'imageUrl' | 'imageUrls'> {
  const rule = getFamilcarCymacoDomainRule(site);
  if (!rule) {
    return {};
  }

  const canonicalSourceUrl = canonicalProductUrl(sourceUrl);
  const products = extractProductsFromHtml(html, finalUrl, 'domain', rule);
  const product = products.find((item) => canonicalProductUrl(item.sourceUrl) === canonicalSourceUrl) ?? products[0];
  const imageUrls = uniqueStrings(product?.imageUrls ?? (product?.imageUrl ? [product.imageUrl] : []))
    .filter(isValidFamilcarCymacoImageUrl);

  return {
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
  };
}

function buildProductWithUpdatedImages(
  previous: ProductRecord,
  images: Pick<ProductRecord, 'imageUrl' | 'imageUrls'>,
): ProductRecord {
  return {
    ...previous,
    imageUrl: images.imageUrl,
    imageUrls: images.imageUrls,
  };
}

function shouldUpdateImages(previous: ProductRecord, next: ProductRecord, newImageValid: boolean): boolean {
  if (!newImageValid) {
    return false;
  }

  return previous.imageUrl !== next.imageUrl
    || JSON.stringify(previous.imageUrls ?? []) !== JSON.stringify(next.imageUrls ?? []);
}

function reasonForResult(wouldUpdate: boolean, newImageValid: boolean, dryRun: boolean): string {
  if (!newImageValid) {
    return 'no_valid_new_image';
  }

  if (!wouldUpdate) {
    return 'unchanged';
  }

  return dryRun ? 'would_update' : 'updated';
}

function summarizeBackfill(
  dryRun: boolean,
  limit: number | undefined,
  site: FamilcarCymacoSite | undefined,
  totalCandidates: number,
  items: FamilcarCymacoImageBackfillItem[],
): FamilcarCymacoImageBackfillSummary {
  return {
    dryRun,
    ...(limit !== undefined ? { limit } : {}),
    ...(site !== undefined ? { site } : {}),
    totalCandidates,
    currentLogoOrPlaceholder: items.filter((item) => item.currentImageInvalid).length,
    newValidImage: items.filter((item) => item.newImageValid).length,
    withoutValidImage: items.filter((item) => !item.newImageValid && !item.error).length,
    wouldUpdate: items.filter((item) => item.wouldUpdate).length,
    updated: items.filter((item) => item.applied).length,
    errors: items.filter((item) => item.error).length,
    items,
  };
}

function assertValidFamilcarCymacoSite(site: FamilcarCymacoSite | undefined): void {
  if (site !== undefined && site !== 'familcar' && site !== 'cymaco') {
    throw new Error(`Invalid --site value "${site}". Expected "familcar" or "cymaco".`);
  }
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

function getFamilcarCymacoDomainRule(siteId: FamilcarCymacoSite): DomainRule | undefined {
  const site = getCatalogSite(siteId);
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
    excludeUrlPatterns: [/\/(?:cart|carrito|checkout|mi-cuenta|account|login|contacto|blog|send|tiendas)(?:\/|\?|$)/i],
    positiveAvailabilityTexts: ['comprar', 'agregar al carrito', 'anadir al carrito', 'en stock', 'disponible'],
    negativeAvailabilityTexts: ['agotado', 'sin stock', 'out of stock', 'no disponible'],
  };
}
