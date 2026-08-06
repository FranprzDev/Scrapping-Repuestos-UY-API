import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { DomainProvider } from '../src/scraping/providers/domain.provider';
import { PlaywrightProvider } from '../src/scraping/providers/playwright.provider';
import type { ProductRecord } from '../src/scraping/interfaces/scraping.types';
import { findDomainRule, getSeedUrls } from '../src/scraping/domain/domain-rules';
import {
  canonicalizeAuditUrl,
  classifyCatalogAudit,
  compareWebAndBase,
  countProductsWithPrice,
  countProductsWithRealImage,
  countProductsWithSku,
  detectLastPagesByListing,
  findDuplicateSkus,
  findDuplicateSourceUrls,
  findPossibleProductDuplicates,
  type CatalogAuditBaseProduct,
  type CatalogAuditPage,
} from '../src/scraping/domain/catalog-audit';

type AuditMethod = 'API' | 'HTML' | 'AJAX' | 'Shopify' | 'Playwright fallback';

interface AuditSiteConfig {
  id: string;
  label: string;
  initialUrls: string[];
  method: AuditMethod;
}

interface AuditReport {
  site: string;
  label: string;
  initialUrls: string[];
  method: AuditMethod;
  status: 'success' | 'error';
  classification: 'CRITICAL' | 'REVIEW' | 'OK';
  durationMs: number;
  categoriesDiscovered: number;
  subcategoriesDiscovered: number;
  categoriesTraversed: number;
  lastPagesByListing: ReturnType<typeof detectLastPagesByListing>;
  pagesVisited: number;
  successfulHttpResponses: number;
  httpErrors: Array<{ url: string; message: string }>;
  productLinksDiscovered: number;
  uniqueCanonicalUrls: number;
  productsExtracted: number;
  productsNormalized: number;
  productsWithPrice: number;
  productsWithoutPrice: number;
  productsWithSku: number;
  productsWithoutSku: number;
  productsWithRealImage: number;
  productsWithoutImage: number;
  placeholderImagesRejected: number;
  productsAvailable: number;
  productsOutOfStock: number;
  duplicateSourceUrls: ReturnType<typeof findDuplicateSourceUrls>;
  duplicateSkus: ReturnType<typeof findDuplicateSkus>;
  possibleDuplicates: ReturnType<typeof findPossibleProductDuplicates>;
  rejectedProducts: Array<{ url?: string; reason: string }>;
  currentBaseRecords: number;
  webUrlsMissingInBase: string[];
  baseUrlsMissingInWeb: string[];
  coveragePercent: number;
  notes: string[];
}

const INVENTORY_URL = 'https://repuestoshopscrapping.up.railway.app/scraping/inventory';
const OUTPUT_DIR = 'tmp/catalog-audit';
const DEFAULT_MAX_PRODUCTS = 100000;
const DEFAULT_MAX_PAGES = 5000;
const REQUEST_PAUSE_MS = 350;

const AUDIT_SITES: AuditSiteConfig[] = [
  { id: 'taxitor', label: 'Taxitor', method: 'HTML', initialUrls: ['https://taxitor.uy/articulos/filtro/1/-/-/'] },
  { id: 'acesur', label: 'Acesur', method: 'API', initialUrls: ['https://acesur.uy/escritorio/ofertas/INTERNET'] },
  { id: 'chaparei', label: 'Chaparei', method: 'AJAX', initialUrls: ['https://www.chaparei.com/productos/'] },
  { id: 'grfrenos', label: 'GR Frenos', method: 'HTML', initialUrls: ['https://www.grfrenos.uy/home/'] },
  { id: 'selvir', label: 'Selvir', method: 'AJAX', initialUrls: ['https://www.selvir.com.uy/'] },
  { id: 'feyvi', label: 'Feyvi', method: 'HTML', initialUrls: ['https://www.feyvi.com.uy/repuestos/acabamiento-interior/'] },
  { id: 'europarts', label: 'Europarts', method: 'HTML', initialUrls: ['https://www.europarts.com.uy/es/search?recordsize=100'] },
  { id: 'multishop', label: 'Multishop', method: 'Shopify', initialUrls: ['https://www.multishop.com.uy/'] },
  { id: 'cymaco', label: 'Cymaco', method: 'AJAX', initialUrls: ['https://cymaco.com.uy/catalogo'] },
  { id: 'familcar', label: 'Familcar', method: 'AJAX', initialUrls: ['https://www.familcar.com/'] },
  { id: 'larrique', label: 'Larrique', method: 'AJAX', initialUrls: ['https://larrique.com.uy/repuestos-autopartes/1'] },
];

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
  return [key, value];
}));

async function main() {
  const siteArg = args.get('site');
  if (!siteArg) {
    console.error('Uso: pnpm run catalog:audit --site=<taxitor|acesur|chaparei|grfrenos|selvir|feyvi|europarts|multishop|cymaco|familcar|larrique|all>');
    process.exit(2);
  }

  const selectedSites = siteArg === 'all'
    ? AUDIT_SITES
    : AUDIT_SITES.filter((site) => site.id === normalizeSiteId(siteArg));

  if (selectedSites.length === 0) {
    console.error(`Sitio no soportado: ${siteArg}`);
    process.exit(2);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const provider = new DomainProvider(new PlaywrightProvider());
  const reports: AuditReport[] = [];

  for (const site of selectedSites) {
    console.log(`Auditando ${site.label} (${site.id})...`);
    const report = await auditSite(provider, site);
    reports.push(report);
    await writeReport(report);
    console.log(`${site.label}: ${report.classification} cobertura=${report.coveragePercent}% web=${report.uniqueCanonicalUrls} base=${report.currentBaseRecords}`);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    inventoryUrl: INVENTORY_URL,
    sites: reports
      .map((report) => ({
        site: report.site,
        label: report.label,
        classification: report.classification,
        coveragePercent: report.coveragePercent,
        uniqueCanonicalUrls: report.uniqueCanonicalUrls,
        currentBaseRecords: report.currentBaseRecords,
        webUrlsMissingInBase: report.webUrlsMissingInBase.length,
        baseUrlsMissingInWeb: report.baseUrlsMissingInWeb.length,
        httpErrors: report.httpErrors.length,
        rejectedProducts: report.rejectedProducts.length,
        notes: report.notes,
      }))
      .sort(compareProblemSeverity),
  };
  await writeFile(`${OUTPUT_DIR}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
}

async function auditSite(provider: DomainProvider, site: AuditSiteConfig): Promise<AuditReport> {
  const started = performance.now();
  const rule = findDomainRule(site.initialUrls[0]);
  const notes: string[] = [];
  const httpErrors: Array<{ url: string; message: string }> = [];

  try {
    const seedUrls = unique([
      ...site.initialUrls,
      ...(rule ? getSeedUrls(site.initialUrls[0], rule) : []),
      ...(rule?.id === 'selvir' ? rule.seedUrls ?? [] : []),
      ...(rule?.id === 'feyvi' ? rule.seedUrls ?? [] : []),
    ]);

    const crawlResults = [];
    for (const seedUrl of seedUrls) {
      await politePause(seedUrl);
      try {
        crawlResults.push(await provider.run('crawl', { url: seedUrl, limit: DEFAULT_MAX_PAGES }));
      } catch (error) {
        httpErrors.push({ url: seedUrl, message: formatError(error) });
      }
    }

    const discoveredUrls = unique(crawlResults.flatMap((result) => extractDiscoveredUrls(result.raw)));
    const targetUrls = unique([...discoveredUrls, ...seedUrls]).slice(0, DEFAULT_MAX_PAGES);
    const categoryUrls = targetUrls.filter((url) => rule?.categoryUrlPatterns.some((pattern) => pattern.test(url)) ?? false);
    const productLinks = targetUrls.filter((url) => rule?.productUrlPatterns.some((pattern) => pattern.test(url)) ?? false);
    const extractionSource = site.initialUrls[0];

    await politePause(extractionSource);
    const extracted = await provider.run('extract', {
      url: extractionSource,
      urls: targetUrls,
      maxItems: DEFAULT_MAX_PRODUCTS,
    });

    const pages = extractPages(extracted.raw);
    const products = extracted.normalizedProducts;
    const webUrls = unique([
      ...productLinks,
      ...products.map((product) => product.sourceUrl).filter((value): value is string => Boolean(value)),
    ]);
    const baseProducts = await fetchInventoryProducts(site.id);
    const comparison = compareWebAndBase(webUrls, baseProducts);
    const images = countProductsWithRealImage(products);
    const productsWithPrice = countProductsWithPrice(products);
    const productsWithSku = countProductsWithSku(products);
    const rejectedProducts = products.flatMap((product) =>
      (product.qualityWarnings ?? []).map((reason) => ({ url: product.sourceUrl, reason })),
    );
    const pagesByListing = detectLastPagesByListing(pages);
    const productsAvailable = products.filter((product) => /in[_ -]?stock|available|disponible/i.test(product.availability ?? '')).length;
    const productsOutOfStock = products.filter((product) => /out[_ -]?of[_ -]?stock|agotado|sin stock|unavailable/i.test(product.availability ?? '')).length;

    if (site.id === 'acesur') {
      notes.push('Comparar totalRecords declarado por la API contra URLs canonicas unicas; las variantes se detectan via sourceUrl/SKU.');
    }
    if (site.id === 'multishop') {
      notes.push('Shopify se cuenta a nivel producto; variantes quedan reflejadas por SKU seleccionado, no como productos separados.');
    }
    if (site.id === 'cymaco' || site.id === 'familcar') {
      notes.push('Fenicio debe mantener paginacion independiente por marca/listado; revisar lastPagesByListing para cortes o paginas repetidas.');
    }
    if (site.id === 'larrique') {
      notes.push('Larrique debe deduplicar entre marcas y validar que la ultima pagina acumulada represente el total declarado.');
    }

    const classification = classifyCatalogAudit({
      coveragePercent: comparison.coveragePercent,
      pages,
      httpErrors,
      productsWithoutPrice: products.length - productsWithPrice,
      productsWithoutSku: products.length - productsWithSku,
      productsWithoutImage: images.missing,
      rejectedProducts,
    });

    return {
      site: site.id,
      label: site.label,
      initialUrls: seedUrls,
      method: site.method,
      status: 'success',
      classification,
      durationMs: Math.round(performance.now() - started),
      categoriesDiscovered: categoryUrls.length,
      subcategoriesDiscovered: estimateSubcategories(categoryUrls),
      categoriesTraversed: unique(pages.map((page) => page.listingUrl ?? page.url)).length,
      lastPagesByListing: pagesByListing,
      pagesVisited: pages.length,
      successfulHttpResponses: pages.length + extractPageCount(crawlResults.map((result) => result.raw)),
      httpErrors,
      productLinksDiscovered: productLinks.length,
      uniqueCanonicalUrls: unique(canonicalWebUrls(webUrls)).length,
      productsExtracted: products.length,
      productsNormalized: products.length,
      productsWithPrice,
      productsWithoutPrice: products.length - productsWithPrice,
      productsWithSku,
      productsWithoutSku: products.length - productsWithSku,
      productsWithRealImage: images.real,
      productsWithoutImage: images.missing,
      placeholderImagesRejected: images.rejected,
      productsAvailable,
      productsOutOfStock,
      duplicateSourceUrls: findDuplicateSourceUrls(products),
      duplicateSkus: findDuplicateSkus(products),
      possibleDuplicates: findPossibleProductDuplicates(products),
      rejectedProducts,
      currentBaseRecords: comparison.currentBaseRecords,
      webUrlsMissingInBase: comparison.webUrlsMissingInBase,
      baseUrlsMissingInWeb: comparison.baseUrlsMissingInWeb,
      coveragePercent: comparison.coveragePercent,
      notes,
    };
  } catch (error) {
    httpErrors.push({ url: site.initialUrls[0], message: formatError(error) });
    const comparison = compareWebAndBase([], await fetchInventoryProducts(site.id).catch(() => []));
    return {
      site: site.id,
      label: site.label,
      initialUrls: site.initialUrls,
      method: site.method,
      status: 'error',
      classification: 'CRITICAL',
      durationMs: Math.round(performance.now() - started),
      categoriesDiscovered: 0,
      subcategoriesDiscovered: 0,
      categoriesTraversed: 0,
      lastPagesByListing: [],
      pagesVisited: 0,
      successfulHttpResponses: 0,
      httpErrors,
      productLinksDiscovered: 0,
      uniqueCanonicalUrls: 0,
      productsExtracted: 0,
      productsNormalized: 0,
      productsWithPrice: 0,
      productsWithoutPrice: 0,
      productsWithSku: 0,
      productsWithoutSku: 0,
      productsWithRealImage: 0,
      productsWithoutImage: 0,
      placeholderImagesRejected: 0,
      productsAvailable: 0,
      productsOutOfStock: 0,
      duplicateSourceUrls: [],
      duplicateSkus: [],
      possibleDuplicates: [],
      rejectedProducts: [],
      currentBaseRecords: comparison.currentBaseRecords,
      webUrlsMissingInBase: comparison.webUrlsMissingInBase,
      baseUrlsMissingInWeb: comparison.baseUrlsMissingInWeb,
      coveragePercent: comparison.coveragePercent,
      notes,
    };
  }
}

async function fetchInventoryProducts(site: string): Promise<CatalogAuditBaseProduct[]> {
  const products: CatalogAuditBaseProduct[] = [];
  const limit = 200;

  for (let offset = 0; ; offset += limit) {
    const url = new URL(INVENTORY_URL);
    url.searchParams.set('site', site);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    await politePause(url.toString());

    const response = await fetchWithRetry(url.toString());
    const data = await response.json() as { products?: CatalogAuditBaseProduct[]; hasMore?: boolean; total?: number };
    const page = Array.isArray(data.products) ? data.products : [];
    products.push(...page);

    const hasMore = Boolean(data.hasMore ?? (page.length === limit && products.length < Number(data.total ?? 0)));
    if (!hasMore || page.length === 0) {
      return products;
    }
  }
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        break;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(`No se pudo leer ${url}`);
}

async function writeReport(report: AuditReport) {
  await writeFile(`${OUTPUT_DIR}/${report.site}.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${OUTPUT_DIR}/${report.site}.csv`, toCsv(report));
}

function toCsv(report: AuditReport): string {
  const rows: Array<[string, string | number]> = [
    ['site', report.site],
    ['initial_url', report.initialUrls.join(' | ')],
    ['method', report.method],
    ['classification', report.classification],
    ['coverage_percent', report.coveragePercent],
    ['categories_discovered', report.categoriesDiscovered],
    ['subcategories_discovered', report.subcategoriesDiscovered],
    ['categories_traversed', report.categoriesTraversed],
    ['pages_visited', report.pagesVisited],
    ['successful_http_responses', report.successfulHttpResponses],
    ['http_errors', report.httpErrors.length],
    ['product_links_discovered', report.productLinksDiscovered],
    ['unique_canonical_urls', report.uniqueCanonicalUrls],
    ['products_extracted', report.productsExtracted],
    ['products_normalized', report.productsNormalized],
    ['products_with_price', report.productsWithPrice],
    ['products_without_price', report.productsWithoutPrice],
    ['products_with_sku', report.productsWithSku],
    ['products_without_sku', report.productsWithoutSku],
    ['products_with_real_image', report.productsWithRealImage],
    ['products_without_image', report.productsWithoutImage],
    ['placeholder_images_rejected', report.placeholderImagesRejected],
    ['products_available', report.productsAvailable],
    ['products_out_of_stock', report.productsOutOfStock],
    ['duplicates_by_source_url', report.duplicateSourceUrls.length],
    ['duplicates_by_sku', report.duplicateSkus.length],
    ['possible_duplicates_name_brand_image', report.possibleDuplicates.length],
    ['rejected_products', report.rejectedProducts.length],
    ['current_base_records', report.currentBaseRecords],
    ['web_urls_missing_in_base', report.webUrlsMissingInBase.length],
    ['base_urls_missing_in_web', report.baseUrlsMissingInWeb.length],
  ];

  return `metric,value\n${rows.map(([metric, value]) => `${csv(metric)},${csv(String(value))}`).join('\n')}\n`;
}

function extractDiscoveredUrls(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const discovered = (raw as { discoveredUrls?: unknown }).discoveredUrls;
  return Array.isArray(discovered) ? discovered.filter((value): value is string => typeof value === 'string') : [];
}

function extractPages(raw: unknown): CatalogAuditPage[] {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const pages = (raw as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) {
    return [];
  }

  return pages
    .filter((page): page is Record<string, unknown> => Boolean(page) && typeof page === 'object')
    .map((page) => ({
      url: typeof page.url === 'string' ? page.url : '',
      method: typeof page.method === 'string' ? page.method : undefined,
      listingUrl: typeof page.listingUrl === 'string' ? page.listingUrl : undefined,
      page: typeof page.page === 'number' ? page.page : undefined,
      productCount: typeof page.productCount === 'number' ? page.productCount : undefined,
      declaredTotal: typeof page.declaredTotal === 'number' ? page.declaredTotal : undefined,
      newInListing: typeof page.newInListing === 'number' ? page.newInListing : undefined,
    }))
    .filter((page) => page.url);
}

function extractPageCount(rawValues: unknown[]): number {
  return rawValues.reduce<number>((total, raw) => total + extractPages(raw).length, 0);
}

function estimateSubcategories(urls: string[]): number {
  return urls.filter((url) => {
    try {
      return new URL(url).pathname.split('/').filter(Boolean).length > 2;
    } catch {
      return false;
    }
  }).length;
}

function canonicalWebUrls(urls: string[]): string[] {
  return urls.map(canonicalizeAuditUrl).filter((value): value is string => Boolean(value));
}

function normalizeSiteId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function compareProblemSeverity(left: { classification: string; coveragePercent: number; httpErrors: number }, right: { classification: string; coveragePercent: number; httpErrors: number }) {
  const order: Record<string, number> = { CRITICAL: 0, REVIEW: 1, OK: 2 };
  return (order[left.classification] ?? 3) - (order[right.classification] ?? 3)
    || left.coveragePercent - right.coveragePercent
    || right.httpErrors - left.httpErrors;
}

async function politePause(url: string) {
  void url;
  await sleep(REQUEST_PAUSE_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
