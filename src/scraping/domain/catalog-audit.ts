import type { ProductRecord } from '../interfaces/scraping.types';

export type CatalogAuditStatus = 'CRITICAL' | 'REVIEW' | 'OK';

export interface CatalogAuditPage {
  url: string;
  method?: string;
  listingUrl?: string;
  page?: number;
  productCount?: number;
  declaredTotal?: number;
  newInListing?: number;
}

export interface CatalogAuditBaseProduct {
  sourceUrl?: string;
  sku?: string;
  productName?: string;
  brand?: string;
  imageUrl?: string;
}

export interface CatalogAuditComparison {
  currentBaseRecords: number;
  webUrlsMissingInBase: string[];
  baseUrlsMissingInWeb: string[];
  coveragePercent: number;
}

export interface CatalogAuditSummaryInput {
  coveragePercent: number;
  pages: CatalogAuditPage[];
  httpErrors: Array<{ url: string; message: string }>;
  productsWithoutPrice: number;
  productsWithoutSku: number;
  productsWithoutImage: number;
  rejectedProducts: Array<{ url?: string; reason: string }>;
}

export function canonicalizeAuditUrl(value?: string): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const url = new URL(value.trim());
    if (!/^https?:$/i.test(url.protocol)) {
      return undefined;
    }

    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    url.pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return undefined;
  }
}

export function uniqueCanonicalUrls(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(canonicalizeAuditUrl).filter((value): value is string => Boolean(value))));
}

export function findDuplicateSourceUrls(products: ProductRecord[]): Array<{ url: string; count: number }> {
  return duplicateCounts(products.map((product) => canonicalizeAuditUrl(product.sourceUrl)));
}

export function findDuplicateSkus(products: ProductRecord[]): Array<{ sku: string; count: number }> {
  const normalized = products
    .map((product) => product.sku?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  return duplicateCounts(normalized).map((item) => ({ sku: item.url, count: item.count }));
}

export function findPossibleProductDuplicates(products: ProductRecord[]): Array<{ key: string; count: number; urls: string[] }> {
  const groups = new Map<string, string[]>();

  for (const product of products) {
    const name = comparable(product.productName);
    const brand = comparable(product.brand);
    const image = canonicalizeAuditUrl(product.imageUrl);
    if (!name || !image) {
      continue;
    }

    const key = `${name}|${brand ?? 'no-brand'}|${image}`;
    const urls = groups.get(key) ?? [];
    urls.push(product.sourceUrl ?? '');
    groups.set(key, urls);
  }

  return Array.from(groups.entries())
    .filter(([, urls]) => urls.length > 1)
    .map(([key, urls]) => ({ key, count: urls.length, urls: uniqueCanonicalUrls(urls) }));
}

export function compareWebAndBase(webUrls: string[], baseProducts: CatalogAuditBaseProduct[]): CatalogAuditComparison {
  const web = new Set(uniqueCanonicalUrls(webUrls));
  const base = new Set(uniqueCanonicalUrls(baseProducts.map((product) => product.sourceUrl)));
  const webUrlsMissingInBase = Array.from(web).filter((url) => !base.has(url)).sort();
  const baseUrlsMissingInWeb = Array.from(base).filter((url) => !web.has(url)).sort();
  const foundInBase = Array.from(web).filter((url) => base.has(url)).length;
  const coveragePercent = web.size === 0 ? (base.size === 0 ? 100 : 0) : roundPercent((foundInBase / web.size) * 100);

  return {
    currentBaseRecords: baseProducts.length,
    webUrlsMissingInBase,
    baseUrlsMissingInWeb,
    coveragePercent,
  };
}

export function detectLastPagesByListing(pages: CatalogAuditPage[]): Array<{ listingUrl: string; lastPage: number; visitedLastPage: boolean; repeatedPagePairs: Array<{ page: number; nextPage: number }> }> {
  const grouped = new Map<string, CatalogAuditPage[]>();

  for (const page of pages) {
    const listingUrl = page.listingUrl ?? page.url;
    const values = grouped.get(listingUrl) ?? [];
    values.push(page);
    grouped.set(listingUrl, values);
  }

  return Array.from(grouped.entries()).map(([listingUrl, values]) => {
    const pageNumbers = values.map((page) => page.page).filter((value): value is number => typeof value === 'number');
    const declaredLast = Math.max(1, ...pageNumbers);
    const repeatedPagePairs: Array<{ page: number; nextPage: number }> = [];
    const ordered = [...values].sort((left, right) => (left.page ?? 1) - (right.page ?? 1));

    for (let index = 0; index < ordered.length - 1; index += 1) {
      const current = ordered[index];
      const next = ordered[index + 1];
      if (
        typeof current.page === 'number'
        && typeof next.page === 'number'
        && current.page + 1 === next.page
        && current.productCount === next.productCount
        && next.newInListing === 0
      ) {
        repeatedPagePairs.push({ page: current.page, nextPage: next.page });
      }
    }

    return {
      listingUrl,
      lastPage: declaredLast,
      visitedLastPage: pageNumbers.includes(declaredLast),
      repeatedPagePairs,
    };
  });
}

export function classifyCatalogAudit(input: CatalogAuditSummaryInput): CatalogAuditStatus {
  const lastPages = detectLastPagesByListing(input.pages);
  const hasPaginationFailure = lastPages.some((page) => !page.visitedLastPage || page.repeatedPagePairs.length > 0);
  const hasSeriousErrors = input.httpErrors.length > 0 || input.rejectedProducts.length > 0;

  if (input.coveragePercent < 70 || hasPaginationFailure || hasSeriousErrors) {
    return 'CRITICAL';
  }

  if (
    input.coveragePercent < 95
    || input.productsWithoutPrice > 0
    || input.productsWithoutSku > 0
    || input.productsWithoutImage > 0
  ) {
    return 'REVIEW';
  }

  return 'OK';
}

export function countProductsWithPrice(products: ProductRecord[]): number {
  return products.filter((product) => Boolean(product.price?.trim())).length;
}

export function countProductsWithSku(products: ProductRecord[]): number {
  return products.filter((product) => Boolean(product.sku?.trim())).length;
}

export function countProductsWithRealImage(products: ProductRecord[]): { real: number; missing: number; rejected: number } {
  let real = 0;
  let missing = 0;
  let rejected = 0;

  for (const product of products) {
    const image = product.imageUrl ?? product.imageUrls?.[0];
    if (!image?.trim()) {
      missing += 1;
    } else if (isPlaceholderImage(image)) {
      rejected += 1;
    } else {
      real += 1;
    }
  }

  return { real, missing, rejected };
}

export function isPlaceholderImage(value: string): boolean {
  const lowered = value.toLowerCase();
  return /placeholder|logo|no[-_ ]?image|sin[-_ ]?imagen|default|favicon/.test(lowered);
}

function duplicateCounts(values: Array<string | undefined>): Array<{ url: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([url, count]) => ({ url, count }));
}

function comparable(value?: string): string | undefined {
  const normalized = value
    ?.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || undefined;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}
