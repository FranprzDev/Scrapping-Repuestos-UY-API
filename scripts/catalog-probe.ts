import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { fetchHtml, type HttpResponseData } from '../src/scraping/domain/http-client';
import { buildFenicioPageUrl } from '../src/scraping/domain/new-catalog-sites';
import {
  dedupeYaguaronProducts,
  extractYaguaronArticlePosition,
  extractYaguaronCategoryUrls,
  extractYaguaronDetail,
  extractYaguaronListingSummary,
  extractYaguaronProductUrls,
} from '../src/scraping/domain/yaguaron';
import { addYaguaronListingProducts } from '../src/scraping/domain/yaguaron-pagination';
import {
  dedupeItalurProducts,
  extractItalurCategoryUrls,
  extractItalurDetail,
  extractItalurListingSummary,
  extractItalurProductUrls,
} from '../src/scraping/domain/italur';
import type { ProductRecord } from '../src/scraping/interfaces/scraping.types';

type Site = 'yaguaron' | 'italur';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
  return [key, value];
}));
const site = args.get('site') as Site | undefined;
if (site !== 'yaguaron' && site !== 'italur') {
  console.error('Uso: pnpm run catalog:probe --site=yaguaron|italur [--max-pages=5000] [--max-products=100000] [--product-url=https://...] [--capture-html=true] [--capture-har=true] [--playwright=false]');
  process.exit(2);
}

const siteUrl = site === 'italur' ? 'https://www.italur.com/tienda/' : 'https://www.yaguaron.com.uy/';
const maxPages = positiveInt(args.get('max-pages'), 5000);
const maxProducts = positiveInt(args.get('max-products'), 100000);
const productUrl = args.get('product-url');
const captureHtml = args.get('capture-html') === 'true';
const allowPlaywright = args.get('playwright') !== 'false';
const captureHar = args.get('capture-har') === 'true';
let browser: Browser | undefined;
let browserContext: BrowserContext | undefined;
const started = performance.now();
const report = {
  site,
  initialUrl: siteUrl,
  method: site === 'italur' ? 'HTTP/WooCommerce' : 'HTTP/Fenicio',
  mode: productUrl ? 'product' : 'catalog',
  status: 'running',
  categoriesDiscovered: [] as string[],
  pagesVisited: [] as Array<{ url: string; method: string; listingUrl?: string; page?: number; discovered: number; newInListing?: number; uniqueInListing?: number; declaredTotal?: number }>,
  productUrlsDiscovered: [] as string[],
  declaredTotals: [] as Array<{ url: string; total: number }>,
  detailPositions: [] as Array<{ url: string; current: number; total: number; note: string }>,
  extracted: 0,
  normalized: 0,
  productsWithImage: 0,
  productsWithoutImage: 0,
  productsOutOfStock: 0,
  rejected: [] as Array<{ url: string; reason: string }>,
  duplicates: [] as Array<{ url: string; duplicateOf: string; reason: 'canonical_url' | 'sku' }>,
  httpErrors: [] as Array<{ url: string; message: string }>,
  requests: [] as Array<{
    url: string;
    finalUrl?: string;
    transport: 'HTTP' | 'Playwright';
    attempt: number;
    statusCode?: number;
    contentType?: string;
    bytes?: number;
    durationMs: number;
    error?: string;
  }>,
  durationMs: 0,
  samples: [] as ProductRecord[],
  products: [] as ProductRecord[],
  directProduct: productUrl ? { downloaded: false, sourceUrl: productUrl } as Record<string, unknown> : undefined as undefined | Record<string, unknown>,
};

async function main() {
  await mkdir('tmp/catalog-probe', { recursive: true });
  try {
    if (productUrl) {
      await probeProduct(productUrl);
      return;
    }
    await probeCatalog();
  } catch {
    report.status = 'error';
  } finally {
    await browserContext?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    report.durationMs = Math.round(performance.now() - started);
    await mkdir('tmp/catalog-probe', { recursive: true });
    await writeFile(`tmp/catalog-probe/${site}.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, products: undefined }, null, 2));
    console.log(`Informe: tmp/catalog-probe/${site}.json`);
    if (report.status !== 'success') process.exitCode = 1;
  }
}

void main();

async function probeProduct(url: string) {
  report.productUrlsDiscovered = [url];
  const response = await get(url);
  if (captureHtml) await capture(`${site}-direct-product.html`, response.body);
  const product = extractDetail(response.body, response.finalUrl);
  report.extracted = 1;
  if (!product) {
    report.rejected.push({ url, reason: `La respuesta no cumple el contrato de ficha ${site}` });
    report.status = 'unvalidated-empty';
    return;
  }
  report.products = [product];
  report.normalized = 1;
  updateProductCounters();
  report.samples = [product];
  report.directProduct = {
    downloaded: true,
    statusCode: response.statusCode,
    productName: product.productName,
    sku: product.sku,
    price: normalizeProbePrice(product.price),
    currency: product.currency,
    manufacturer: product.attributes?.fabricante,
    references: product.attributes?.referencias ?? product.attributes?.codigo,
    imageUrl: product.imageUrl,
    availability: product.availability,
    stock: product.stock,
    sourceUrl: product.sourceUrl,
  };
  report.status = 'success';
}

async function probeCatalog() {
  const home = await get(siteUrl);
  report.categoriesDiscovered = extractCategoryUrls(home.body, home.finalUrl);
  const queue = (report.categoriesDiscovered.length > 0 ? report.categoriesDiscovered : [siteUrl])
    .filter((url) => url !== home.finalUrl);
  const productUrls = new Set<string>(extractProductUrls(home.body, home.finalUrl));
  const homeItalurSummary = site === 'italur' ? extractItalurListingSummary(home.body, home.finalUrl) : undefined;
  const homeYaguaronSummary = site === 'yaguaron' ? extractYaguaronListingSummary(home.body) : undefined;
  report.pagesVisited.push({
    url: home.finalUrl,
    method: 'HTTP',
    listingUrl: siteUrl,
    page: homeItalurSummary?.currentPage ?? 1,
    discovered: productUrls.size,
    newInListing: productUrls.size,
    uniqueInListing: productUrls.size,
    declaredTotal: homeYaguaronSummary?.declaredTotal ?? homeItalurSummary?.lastPage,
  });

  for (const category of queue) {
    if (report.pagesVisited.length >= maxPages) break;
    const listingProducts = new Set<string>();
    let nextUrl: string | undefined = category;
    for (let page = 1; nextUrl && report.pagesVisited.length < maxPages; page += 1) {
      const url = site === 'italur' ? nextUrl : page === 1 ? category : buildFenicioPageUrl(category, page);
      let response: HttpResponseData;
      try {
        response = await get(url, page > 1 && site === 'yaguaron' ? { 'x-requested-with': 'XMLHttpRequest', referer: category } : undefined);
      } catch {
        break;
      }
      if (captureHtml) await capture(`${site}-${report.pagesVisited.length + 1}.html`, response.body);
      const found = extractProductUrls(response.body, response.finalUrl);
      const italurSummary = site === 'italur' ? extractItalurListingSummary(response.body, response.finalUrl) : undefined;
      const yaguaronSummary = site === 'yaguaron' ? extractYaguaronListingSummary(response.body) : undefined;
      const declaredTotal = yaguaronSummary?.declaredTotal ?? italurSummary?.lastPage;
      const progress = addYaguaronListingProducts(found, listingProducts, productUrls, yaguaronSummary?.declaredTotal);
      report.pagesVisited.push({
        url: response.finalUrl,
        method: site === 'italur' ? 'HTTP' : page === 1 ? 'HTTP' : 'Fenicio AJAX',
        listingUrl: category,
        page: italurSummary?.currentPage ?? page,
        discovered: progress.discovered,
        newInListing: progress.newInListing,
        uniqueInListing: progress.uniqueInListing,
        declaredTotal,
      });
      if (yaguaronSummary?.declaredTotal) report.declaredTotals.push({ url: category, total: yaguaronSummary.declaredTotal });
      nextUrl = italurSummary?.nextPageUrl;
      if (progress.noNewInThisListing || found.length === 0 || progress.reachedDeclaredTotal || (site === 'italur' && !nextUrl)) break;
    }
  }

  report.productUrlsDiscovered = Array.from(productUrls).slice(0, maxProducts);
  const byCanonical = new Map<string, ProductRecord>();
  const bySku = new Map<string, string>();
  for (const url of report.productUrlsDiscovered) {
    try {
      const response = await get(url);
      if (captureHtml) await capture(`${site}-product-${report.extracted + report.rejected.length + 1}.html`, response.body);
      const product = extractDetail(response.body, response.finalUrl);
      const position = site === 'yaguaron' ? extractYaguaronArticlePosition(response.body) : undefined;
      if (position) report.detailPositions.push({ url, ...position, note: 'Indicador de navegacion de ficha; no se considera total global sin correlacion con el listado.' });
      report.extracted += 1;
      if (!product) { report.rejected.push({ url, reason: `La respuesta no cumple el contrato de ficha ${site}` }); continue; }
      if (!product.productName) { report.rejected.push({ url, reason: 'productName ausente' }); continue; }
      if (!product.sourceUrl) { report.rejected.push({ url, reason: 'sourceUrl canonica ausente' }); continue; }
      const previousUrl = byCanonical.has(product.sourceUrl) ? product.sourceUrl : product.sku ? bySku.get(product.sku.toLowerCase()) : undefined;
      if (previousUrl) { report.duplicates.push({ url, duplicateOf: previousUrl, reason: previousUrl === product.sourceUrl ? 'canonical_url' : 'sku' }); continue; }
      byCanonical.set(product.sourceUrl, product);
      if (product.sku) bySku.set(product.sku.toLowerCase(), product.sourceUrl);
    } catch {
      // get() already records the HTTP error.
    }
  }
  report.products = site === 'italur'
    ? dedupeItalurProducts(Array.from(byCanonical.values())).products
    : dedupeYaguaronProducts(Array.from(byCanonical.values())).products;
  report.normalized = report.products.length;
  updateProductCounters();
  report.samples = report.products.slice(0, 5);
  report.status = report.normalized > 0 ? 'success' : 'unvalidated-empty';
}

function extractCategoryUrls(html: string, finalUrl: string): string[] {
  return site === 'italur' ? extractItalurCategoryUrls(html, finalUrl) : extractYaguaronCategoryUrls(html, finalUrl);
}

function extractProductUrls(html: string, finalUrl: string): string[] {
  return site === 'italur' ? extractItalurProductUrls(html, finalUrl) : extractYaguaronProductUrls(html, finalUrl);
}

function extractDetail(html: string, finalUrl: string): ProductRecord | undefined {
  return site === 'italur' ? extractItalurDetail(html, finalUrl, 'domain') : extractYaguaronDetail(html, finalUrl, 'domain');
}

function updateProductCounters() {
  report.productsWithImage = report.products.filter((product) => Boolean(product.imageUrl)).length;
  report.productsWithoutImage = report.products.filter((product) => !product.imageUrl).length;
  report.productsOutOfStock = report.products.filter((product) => product.availability === 'out_of_stock').length;
}

async function get(url: string, headers?: Record<string, string>): Promise<HttpResponseData> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const requestStarted = performance.now();
    try {
      const response = await fetchHtml(url, 5, { headers, timeoutMs: 45_000 });
      report.requests.push({
        url,
        finalUrl: response.finalUrl,
        transport: 'HTTP',
        attempt,
        statusCode: response.statusCode,
        contentType: headerValue(response.headers['content-type']),
        bytes: Buffer.byteLength(response.body),
        durationMs: Math.round(performance.now() - requestStarted),
      });
      if (response.statusCode >= 200 && response.statusCode < 300 && response.body.trim()) return response;
      throw new Error(`HTTP ${response.statusCode}; bytes=${response.body.length}`);
    } catch (error) {
      lastError = error;
      if (!report.requests.some((request) => request.url === url && request.transport === 'HTTP' && request.attempt === attempt)) {
        report.requests.push({
          url,
          transport: 'HTTP',
          attempt,
          durationMs: Math.round(performance.now() - requestStarted),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  report.httpErrors.push({ url, message: `HTTP: ${message}` });
  if (allowPlaywright) {
    const requestStarted = performance.now();
    try {
      browser ??= await chromium.launch({ headless: true });
      browserContext ??= await browser.newContext(captureHar ? { recordHar: { path: `tmp/catalog-probe/${site}.har`, mode: 'minimal' } } : {});
      const page = await browserContext.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const body = await page.content();
      const statusCode = response?.status() ?? 0;
      const responseHeaders = response?.headers() ?? {};
      report.requests.push({
        url,
        finalUrl: response?.url(),
        transport: 'Playwright',
        attempt: 1,
        statusCode,
        contentType: responseHeaders['content-type'],
        bytes: Buffer.byteLength(body),
        durationMs: Math.round(performance.now() - requestStarted),
      });
      await page.close();
      if (response?.ok() && body.trim()) {
        report.method = `${report.method} + Playwright fallback`;
        return { url, finalUrl: response.url(), statusCode: response.status(), headers: response.headers(), body };
      }
      throw new Error(`Playwright HTTP ${response?.status() ?? 0}; bytes=${body.length}`);
    } catch (error) {
      const playwrightMessage = error instanceof Error ? error.message : String(error);
      if (!report.requests.some((request) => request.url === url && request.transport === 'Playwright')) {
        report.requests.push({ url, transport: 'Playwright', attempt: 1, durationMs: Math.round(performance.now() - requestStarted), error: playwrightMessage });
      }
      report.httpErrors.push({ url, message: `Playwright: ${playwrightMessage}` });
    }
  }
  throw lastError;
}

async function capture(name: string, body: string) {
  await mkdir('tmp/catalog-probe/html', { recursive: true });
  await writeFile(`tmp/catalog-probe/html/${name}`, sanitize(body));
}

function sanitize(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/(<input\b[^>]*(?:csrf|token|email|phone)[^>]*value=")[^"]*/gi, '$1[REDACTED]');
}

function positiveInt(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

function normalizeProbePrice(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s/g, '');
  if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) return normalized.replace(/\./g, '');
  return normalized.replace(',', '.');
}
