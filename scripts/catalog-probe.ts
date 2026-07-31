import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fetchHtml, type HttpResponseData } from '../src/scraping/domain/http-client';
import { buildFenicioPageUrl } from '../src/scraping/domain/new-catalog-sites';
import {
  extractYaguaronCategoryUrls,
  extractYaguaronArticlePosition,
  extractYaguaronDetail,
  extractYaguaronListingSummary,
  extractYaguaronProductUrls,
} from '../src/scraping/domain/yaguaron';
import type { ProductRecord } from '../src/scraping/interfaces/scraping.types';
import { chromium, type Browser, type BrowserContext } from 'playwright';

const SITE_URL = 'https://www.yaguaron.com.uy/';
const args = new Map(process.argv.slice(2).map((arg) => { const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2); return [key, value]; }));
const site = args.get('site');
if (site !== 'yaguaron') {
  console.error('Uso: pnpm run catalog:probe --site=yaguaron [--max-pages=5000] [--max-products=100000] [--capture-html=true] [--capture-har=true] [--playwright=false]');
  process.exit(2);
}

const maxPages = positiveInt(args.get('max-pages'), 5000);
const maxProducts = positiveInt(args.get('max-products'), 100000);
const captureHtml = args.get('capture-html') === 'true';
const allowPlaywright = args.get('playwright') !== 'false';
const captureHar = args.get('capture-har') === 'true';
let browser: Browser | undefined;
let browserContext: BrowserContext | undefined;
const started = performance.now();
const report = {
  site,
  initialUrl: SITE_URL,
  method: 'HTTP/Fenicio',
  status: 'running',
  categoriesDiscovered: [] as string[],
  pagesVisited: [] as Array<{ url: string; method: string; discovered: number; declaredTotal?: number }>,
  productUrlsDiscovered: [] as string[],
  declaredTotals: [] as Array<{ url: string; total: number }>,
  detailPositions: [] as Array<{ url: string; current: number; total: number; note: string }>,
  extracted: 0,
  normalized: 0,
  rejected: [] as Array<{ url: string; reason: string }>,
  duplicates: [] as Array<{ url: string; duplicateOf: string; reason: 'canonical_url' | 'sku' }>,
  httpErrors: [] as Array<{ url: string; message: string }>,
  durationMs: 0,
  samples: [] as ProductRecord[],
  products: [] as ProductRecord[],
};

async function main() {
await mkdir('tmp/catalog-probe', { recursive: true });
try {
  const home = await get(SITE_URL);
  report.categoriesDiscovered = extractYaguaronCategoryUrls(home.body, home.finalUrl);
  const queue = report.categoriesDiscovered.length > 0 ? report.categoriesDiscovered : [SITE_URL];
  const productUrls = new Set<string>(extractYaguaronProductUrls(home.body, home.finalUrl));

  for (const category of queue) {
    const categoryStart = productUrls.size;
    let previous = productUrls.size;
    for (let page = 1; page <= maxPages && productUrls.size < maxProducts; page += 1) {
      const url = page === 1 ? category : buildFenicioPageUrl(category, page);
      let response: HttpResponseData;
      try { response = await get(url, page > 1 ? { 'x-requested-with': 'XMLHttpRequest', referer: category } : undefined); }
      catch { break; }
      if (captureHtml) await capture(`${site}-${report.pagesVisited.length + 1}.html`, response.body);
      const summary = extractYaguaronListingSummary(response.body);
      const found = extractYaguaronProductUrls(response.body, response.finalUrl);
      found.forEach((value) => productUrls.add(value));
      report.pagesVisited.push({ url: response.finalUrl, method: page === 1 ? 'HTTP' : 'Fenicio AJAX', discovered: found.length, declaredTotal: summary.declaredTotal });
      if (summary.declaredTotal) report.declaredTotals.push({ url: category, total: summary.declaredTotal });
      const noNew = productUrls.size === previous;
      const reachedTotal = Boolean(summary.declaredTotal && productUrls.size - categoryStart >= summary.declaredTotal);
      if (noNew || found.length === 0 || reachedTotal) break;
      previous = productUrls.size;
    }
  }

  report.productUrlsDiscovered = Array.from(productUrls).slice(0, maxProducts);
  const byCanonical = new Map<string, ProductRecord>();
  const bySku = new Map<string, string>();
  for (const url of report.productUrlsDiscovered) {
    try {
      const response = await get(url);
      if (captureHtml) await capture(`${site}-product-${report.extracted + report.rejected.length + 1}.html`, response.body);
      const product = extractYaguaronDetail(response.body, response.finalUrl, 'domain');
      const position = extractYaguaronArticlePosition(response.body);
      if (position) report.detailPositions.push({ url, ...position, note: 'Indicador de navegación de ficha; no se considera total global sin correlación con el listado.' });
      report.extracted += 1;
      if (!product) { report.rejected.push({ url, reason: 'La respuesta no cumple el contrato de ficha Yaguarón' }); continue; }
      if (!product.productName) { report.rejected.push({ url, reason: 'productName ausente' }); continue; }
      if (!product.sourceUrl) { report.rejected.push({ url, reason: 'sourceUrl canónica ausente' }); continue; }
      const previousUrl = byCanonical.has(product.sourceUrl) ? product.sourceUrl : product.sku ? bySku.get(product.sku.toLowerCase()) : undefined;
      if (previousUrl) { report.duplicates.push({ url, duplicateOf: previousUrl, reason: previousUrl === product.sourceUrl ? 'canonical_url' : 'sku' }); continue; }
      byCanonical.set(product.sourceUrl, product);
      if (product.sku) bySku.set(product.sku.toLowerCase(), product.sourceUrl);
    } catch { /* get() already records the HTTP error. */ }
  }
  report.products = Array.from(byCanonical.values());
  report.normalized = report.products.length;
  report.samples = report.products.slice(0, 5);
  report.status = report.normalized > 0 ? 'success' : 'unvalidated-empty';
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

async function get(url: string, headers?: Record<string, string>): Promise<HttpResponseData> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchHtml(url, 5, { headers, timeoutMs: 45_000 });
      if (response.statusCode >= 200 && response.statusCode < 300 && response.body.trim()) return response;
      throw new Error(`HTTP ${response.statusCode}; bytes=${response.body.length}`);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  report.httpErrors.push({ url, message: `HTTP: ${message}` });
  if (allowPlaywright) {
    try {
      browser ??= await chromium.launch({ headless: true });
      browserContext ??= await browser.newContext(captureHar ? { recordHar: { path: `tmp/catalog-probe/${site}.har`, mode: 'minimal' } } : {});
      const page = await browserContext.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const body = await page.content();
      await page.close();
      if (response?.ok() && body.trim()) {
        report.method = 'HTTP + Playwright fallback';
        return { url, finalUrl: response.url(), statusCode: response.status(), headers: response.headers(), body };
      }
      throw new Error(`Playwright HTTP ${response?.status() ?? 0}; bytes=${body.length}`);
    } catch (error) {
      const playwrightMessage = error instanceof Error ? error.message : String(error);
      report.httpErrors.push({ url, message: `Playwright: ${playwrightMessage}` });
    }
  }
  throw lastError;
}
async function capture(name: string, body: string) { await mkdir('tmp/catalog-probe/html', { recursive: true }); await writeFile(`tmp/catalog-probe/html/${name}`, sanitize(body)); }
function sanitize(html: string): string { return html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/(<input\b[^>]*(?:csrf|token|email|phone)[^>]*value=")[^"]*/gi, '$1[REDACTED]'); }
function positiveInt(value: string | undefined, fallback: number): number { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback; }
