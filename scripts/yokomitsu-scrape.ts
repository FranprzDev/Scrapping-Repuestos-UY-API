import 'dotenv/config';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  runYokomitsuFullCatalog,
  createEmptyYokomitsuCheckpoint,
  parseYokomitsuScrapeArgs,
  sanitizeYokomitsuCheckpoint,
  type YokomitsuFullCheckpoint,
  type YokomitsuFullProgress,
} from '../src/scraping/domain/yokomitsu-full';
import {
  extractSetCookieNames,
  type YokomitsuHttpClient,
  type YokomitsuHttpResponse,
} from '../src/scraping/domain/yokomitsu-auth';
import { YOKOMITSU_FRONT_COOKIE_NAME } from '../src/scraping/domain/yokomitsu';
import type { ProductRecord } from '../src/scraping/interfaces/scraping.types';

const args = parseYokomitsuScrapeArgs(process.argv.slice(2));
const outputPath = resolve(args.get('output') ?? './tmp/yokomitsu-products.jsonl');
const checkpointPath = resolve(args.get('checkpoint') ?? './tmp/yokomitsu-checkpoint.json');
const username = process.env.YOKOMITSU_USERNAME;
const password = process.env.YOKOMITSU_PASSWORD;

async function main(): Promise<void> {
  if (!username || !password) {
    console.error('Missing YOKOMITSU_USERNAME/YOKOMITSU_PASSWORD environment variables.');
    process.exitCode = 1;
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(checkpointPath), { recursive: true });

  const client = new CookieJarHttpClient();
  try {
    const checkpoint = await loadCheckpoint(checkpointPath);
    const result = await runYokomitsuFullCatalog(client, {
      credentials: { username, password },
      checkpoint,
      outputProduct: (product) => appendJsonLine(outputPath, product),
      onCheckpoint: (next) => saveCheckpoint(checkpointPath, next),
      onProgress: printProgress,
    });

    console.log(JSON.stringify({
      status: result.limitations.length > 0 ? 'completed-with-limitations' : 'success',
      discoveryMethod: result.discoveryMethod,
      emptySearchReturnedGlobalCatalog: result.emptySearchReturnedGlobalCatalog,
      categoriesDiscovered: result.categoriesDiscovered,
      subcategoriesDiscovered: result.subcategoriesDiscovered,
      leafCategoriesProcessed: result.leafCategoriesProcessed,
      totalResults: result.totalResults,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
      pagesProcessed: result.pagesProcessed,
      urlsDiscovered: result.urlsDiscovered,
      uniqueProducts: result.uniqueProducts,
      productsProcessed: result.productsProcessed,
      validProducts: result.validProducts,
      duplicates: result.duplicates,
      errors: result.errors,
      sessionRenewed: result.sessionRenewed,
      failedCategories: result.failedCategories,
      outputPath,
      checkpointPath,
      limitations: result.limitations,
    }, null, 2));
  } finally {
    await client.clearSession();
  }
}

class CookieJarHttpClient implements YokomitsuHttpClient {
  private readonly cookies = new Map<string, string>();

  async get(url: string, headers: Record<string, string> = {}): Promise<YokomitsuHttpResponse> {
    return this.request(url, { method: 'GET', headers });
  }

  async post(url: string, body: string, headers: Record<string, string> = {}): Promise<YokomitsuHttpResponse> {
    return this.request(url, { method: 'POST', headers, body });
  }

  async getCookieNames(): Promise<string[]> {
    return Array.from(this.cookies.keys()).sort();
  }

  async clearSession(): Promise<void> {
    this.cookies.clear();
  }

  private async request(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<YokomitsuHttpResponse> {
    const headers = { ...init.headers };
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) headers.cookie = cookieHeader;
    const response = await fetch(url, {
      method: init.method,
      headers,
      body: init.body,
      redirect: 'follow',
    });
    const responseHeaders = headersToRecord(response.headers);
    const setCookies = getSetCookieHeaders(response.headers);
    if (setCookies.length > 0) {
      responseHeaders['set-cookie'] = setCookies;
      this.storeSetCookies(setCookies);
    }
    return {
      url: response.url,
      status: response.status,
      headers: responseHeaders,
      body: await response.text(),
    };
  }

  private storeSetCookies(values: string[]): void {
    for (const value of values) {
      const [pair] = value.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1);
      if (name) this.cookies.set(name, cookieValue);
    }
  }

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return Array.from(this.cookies.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

async function loadCheckpoint(path: string): Promise<YokomitsuFullCheckpoint> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as YokomitsuFullCheckpoint;
    return sanitizeYokomitsuCheckpoint(parsed);
  } catch {
    return createEmptyYokomitsuCheckpoint();
  }
}

async function saveCheckpoint(path: string, checkpoint: YokomitsuFullCheckpoint): Promise<void> {
  await writeFile(path, `${JSON.stringify(sanitizeYokomitsuCheckpoint(checkpoint), null, 2)}\n`, 'utf8');
}

async function appendJsonLine(path: string, product: ProductRecord): Promise<void> {
  await appendFile(path, `${JSON.stringify(product)}\n`, 'utf8');
}

function printProgress(progress: YokomitsuFullProgress): void {
  console.log(JSON.stringify({
    pagesProcessed: progress.pagesProcessed,
    totalPages: progress.totalPages,
    categoriesDiscovered: progress.categoriesDiscovered,
    subcategoriesDiscovered: progress.subcategoriesDiscovered,
    leafCategoriesProcessed: progress.leafCategoriesProcessed,
    urlsDiscovered: progress.urlsDiscovered,
    uniqueProducts: progress.uniqueProducts,
    productsProcessed: progress.productsProcessed,
    validProducts: progress.validProducts,
    duplicates: progress.duplicates,
    errors: progress.errors,
    sessionRenewed: progress.sessionRenewed,
    elapsedMs: progress.elapsedMs,
  }));
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function getSetCookieHeaders(headers: Headers): string[] {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (values && values.length > 0) return values;
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

if (process.argv[1]?.match(/yokomitsu-scrape\.(?:ts|js)$/)) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redact(message));
    process.exitCode = 1;
  });
}

function redact(value: string): string {
  return value
    .replace(/(authorization|cookie|auth_token|token|password|pass|rut)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(new RegExp(`${YOKOMITSU_FRONT_COOKIE_NAME}=[^;\\s]+`, 'gi'), `${YOKOMITSU_FRONT_COOKIE_NAME}=[REDACTED]`)
    .replace(new RegExp(extractSetCookieNames({ 'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED` }).join('|'), 'g'), YOKOMITSU_FRONT_COOKIE_NAME);
}
