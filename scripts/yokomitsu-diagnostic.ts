import 'dotenv/config';
import { chromium, type Page, type Request, type Response } from 'playwright';
import {
  extractFieldNamesFromBody,
  extractYokomitsuProductsFromJson,
  inferApproximateProductCount,
  inferPaginationFromCalls,
  inferYokomitsuFieldsAvailable,
  isLikelyYokomitsuCatalogUrl,
  sanitizeRequestBody,
  sanitizeUrl,
  summarizeJsonShape,
  YOKOMITSU_BASE_URL,
  YOKOMITSU_LOGIN_URL,
  YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS,
  type YokomitsuDiagnosticReport,
  type YokomitsuNetworkCall,
} from '../src/scraping/domain/yokomitsu';
import type { ProductRecord } from '../src/scraping/interfaces/scraping.types';

const USERNAME = process.env.YOKOMITSU_USERNAME;
const PASSWORD = process.env.YOKOMITSU_PASSWORD;
const TIMEOUT_MS = positiveInt(process.env.YOKOMITSU_DIAGNOSTIC_TIMEOUT_MS, 60_000);
const MAX_CATALOG_REQUESTS = 30;

const report: YokomitsuDiagnosticReport = {
  site: 'yokomitsu',
  loginUrl: YOKOMITSU_LOGIN_URL,
  status: 'error',
  authenticated: false,
  reachedPortal: false,
  login: {
    fieldNames: [],
    usesSessionCookie: false,
    usesJwt: false,
    usesBearerToken: false,
    usesLocalStorage: false,
    usesRefreshToken: false,
  },
  catalogApiCandidates: [],
  pagination: {
    observedParams: [],
    observedFields: [],
  },
  captchaDetected: false,
  twoFactorDetected: false,
  restrictions: [],
  samples: [],
  fieldsAvailable: inferYokomitsuFieldsAvailable([]),
  notes: [
    `diagnostic limited to ${YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS} products`,
    'credentials, cookies, bearer tokens and authorization headers are never printed',
  ],
  extractedAt: new Date().toISOString(),
};

async function main() {
  if (!USERNAME || !PASSWORD) {
    report.status = 'missing-env';
    report.notes.push('set YOKOMITSU_USERNAME and YOKOMITSU_PASSWORD to run the authenticated diagnostic');
    printReport();
    return;
  }

  const browser = await chromium.launch({ headless: process.env.YOKOMITSU_HEADLESS !== 'false' });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'es-UY',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.setDefaultNavigationTimeout(TIMEOUT_MS);

  const requests = new Map<Request, YokomitsuNetworkCall>();
  const productSamples = new Map<string, ProductRecord>();
  let sawAuthorizationHeader = false;

  page.on('request', (request) => {
    if (!isYokomitsuUrl(request.url())) return;
    const headers = request.headers();
    sawAuthorizationHeader ||= typeof headers.authorization === 'string' && headers.authorization.trim().length > 0;
    const call: YokomitsuNetworkCall = {
      method: request.method(),
      url: sanitizeUrl(request.url()),
      resourceType: request.resourceType(),
      requestBody: sanitizeRequestBody(request.postData()),
    };
    requests.set(request, call);
    if (isLikelyLoginRequest(request)) {
      report.login.fieldNames = extractFieldNamesFromBody(request.postData());
      report.login.method = request.method();
      report.login.endpoint = sanitizeUrl(request.url());
    }
  });

  page.on('response', (response) => {
    void inspectResponse(response, requests, productSamples);
  });

  try {
    await page.goto(YOKOMITSU_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);

    report.captchaDetected = await detectCaptcha(page);
    if (report.captchaDetected) {
      report.status = 'blocked';
      report.restrictions.push('CAPTCHA detected on login page; diagnostic stopped before submitting credentials');
      return;
    }

    const filled = await fillLoginForm(page, USERNAME, PASSWORD);
    if (!filled) {
      report.status = 'blocked';
      report.restrictions.push('Could not identify username/password fields safely');
      return;
    }

    await submitLogin(page);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(1500);

    report.captchaDetected = report.captchaDetected || await detectCaptcha(page);
    report.twoFactorDetected = await detectTwoFactor(page);
    report.reachedPortal = await hasReachedPortal(page);
    report.authenticated = report.reachedPortal && !report.twoFactorDetected;

    const cookies = await context.cookies();
    report.login.usesSessionCookie = cookies.some((cookie) => /session|sess|sid|php|laravel|ci_session|connect/i.test(cookie.name)) || cookies.length > 0;
    const storageSignals = await inspectStorage(page);
    report.login.usesLocalStorage = storageSignals.localStorageKeys > 0;
    report.login.usesJwt = storageSignals.hasJwt;
    report.login.usesRefreshToken = storageSignals.hasRefreshToken;
    report.login.usesBearerToken = sawAuthorizationHeader || storageSignals.hasBearer;

    if (!report.authenticated) {
      report.status = report.twoFactorDetected ? 'blocked' : 'login-failed';
      if (report.twoFactorDetected) report.restrictions.push('2FA or verification code prompt detected; diagnostic stopped');
      else report.restrictions.push('Login did not reach an authenticated portal view');
      return;
    }

    await exploreCatalog(page);
    await page.waitForTimeout(1500);

    const domProducts = await extractProductsFromDom(page);
    for (const product of domProducts) addProduct(productSamples, product);

    report.samples = Array.from(productSamples.values()).slice(0, YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS);
    report.catalogApiCandidates = Array.from(requests.values())
      .filter((call) => isLikelyYokomitsuCatalogUrl(call.url) || call.responseShape)
      .slice(0, MAX_CATALOG_REQUESTS);
    report.pagination = inferPaginationFromCalls(report.catalogApiCandidates);
    report.approximateProductCount = inferApproximateProductCount(report.catalogApiCandidates.map((call) => call.responseShape));
    report.pricesMayDependOnAuthenticatedUser = report.samples.some((product) => Boolean(product.price));
    report.fieldsAvailable = inferYokomitsuFieldsAvailable(report.samples);
    report.status = 'success';
  } catch (error) {
    report.status = 'error';
    report.restrictions.push(redactError(error));
  } finally {
    await context.clearCookies().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    printReport();
  }
}

async function inspectResponse(
  response: Response,
  requests: Map<Request, YokomitsuNetworkCall>,
  productSamples: Map<string, ProductRecord>,
) {
  const request = response.request();
  const call = requests.get(request);
  if (!call) return;
  call.status = response.status();
  call.contentType = response.headers()['content-type'];

  if (!/application\/json|text\/json/i.test(call.contentType ?? '') && !isLikelyYokomitsuCatalogUrl(response.url())) {
    return;
  }

  try {
    const body = await response.json();
    call.responseShape = summarizeJsonShape(body);
    const products = extractYokomitsuProductsFromJson(body, YOKOMITSU_BASE_URL);
    for (const product of products) addProduct(productSamples, product);
  } catch {
    // Ignore non-JSON or streaming responses; the diagnostic only records safe shapes.
  }
}

async function fillLoginForm(page: Page, username: string, password: string): Promise<boolean> {
  const passwordInput = page.locator('input[type="password"]').first();
  if (await passwordInput.count() === 0) return false;
  const usernameInput = page.locator([
    'input[name*="user" i]',
    'input[name*="usuario" i]',
    'input[name*="email" i]',
    'input[name*="login" i]',
    'input[name*="cliente" i]',
    'input[type="email"]',
    'input[type="text"]',
  ].join(', ')).first();
  if (await usernameInput.count() === 0) return false;

  await usernameInput.fill(username);
  await passwordInput.fill(password);
  return true;
}

async function submitLogin(page: Page): Promise<void> {
  const submit = page.locator([
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Ingresar")',
    'button:has-text("Entrar")',
    'button:has-text("Login")',
    'button:has-text("Iniciar")',
  ].join(', ')).first();

  if (await submit.count() > 0) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => undefined),
      submit.click(),
    ]);
    return;
  }

  await page.keyboard.press('Enter');
}

async function exploreCatalog(page: Page): Promise<void> {
  const candidateUrls = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .map((anchor) => ({ href: anchor.href, text: anchor.textContent?.trim() ?? '' }))
    .filter((item) => /catalog|catalogo|producto|productos|repuesto|repuestos|stock|precio|marca|modelo|buscar|busqueda/i.test(`${item.href} ${item.text}`))
    .map((item) => item.href)
    .slice(0, 5));

  for (const href of candidateUrls) {
    try {
      await page.goto(href, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
    } catch {
      // Continue probing other safe catalog-looking links.
    }
  }
}

async function extractProductsFromDom(page: Page): Promise<ProductRecord[]> {
  return page.evaluate((baseUrl) => {
    const cards = Array.from(document.querySelectorAll('[data-product], [data-codprod], .product, .producto, .card, tr'))
      .slice(0, 20);
    const cleaned = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim() || undefined;
    const toUrl = (value: string | null | undefined) => {
      if (!value) return undefined;
      try { return new URL(value, baseUrl).toString(); } catch { return undefined; }
    };

    return cards.flatMap((card) => {
      const anchor = card.querySelector<HTMLAnchorElement>('a[href]');
      const image = card.querySelector<HTMLImageElement>('img[src], img[data-src]');
      const text = cleaned(card.textContent);
      const name = cleaned(card.querySelector('h1,h2,h3,h4,[class*="name"],[class*="nombre"],[class*="descripcion"],[class*="producto"]')?.textContent)
        ?? cleaned(anchor?.textContent);
      const price = text?.match(/(?:US\$|\$U|\$|UYU|USD)?\s*\d[\d.,]*/i)?.[0];
      const sku = cleaned(card.getAttribute('data-codprod'))
        ?? cleaned(card.querySelector('[class*="sku"],[class*="codigo"],[class*="code"]')?.textContent);
      if (!name && !sku) return [];
      return [{
        productName: name,
        sourceUrl: toUrl(anchor?.getAttribute('href')) ?? location.href,
        sku,
        price,
        imageUrl: toUrl(image?.getAttribute('src') ?? image?.getAttribute('data-src')),
        description: text && text.length <= 500 ? text : undefined,
        provider: 'Yokomitsu' as const,
        extractedAt: new Date().toISOString(),
      }];
    }).slice(0, 5);
  }, YOKOMITSU_BASE_URL);
}

async function detectCaptcha(page: Page): Promise<boolean> {
  return page.evaluate(() => /captcha|recaptcha|hcaptcha/i.test(document.body.innerHTML));
}

async function detectTwoFactor(page: Page): Promise<boolean> {
  return page.evaluate(() => /2fa|c[oó]digo de verificaci[oó]n|verificaci[oó]n|otp|token/i.test(document.body.textContent ?? ''));
}

async function hasReachedPortal(page: Page): Promise<boolean> {
  const url = page.url();
  const hasPassword = await page.locator('input[type="password"]').count().catch(() => 1);
  return !/\/login(?:[/?#]|$)/i.test(url) && hasPassword === 0;
}

async function inspectStorage(page: Page): Promise<{ localStorageKeys: number; hasJwt: boolean; hasBearer: boolean; hasRefreshToken: boolean }> {
  return page.evaluate(() => {
    const entries = Object.keys(localStorage).map((key) => ({ key, value: localStorage.getItem(key) ?? '' }));
    const text = entries.map((entry) => `${entry.key} ${entry.value}`).join(' ');
    return {
      localStorageKeys: entries.length,
      hasJwt: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text),
      hasBearer: /bearer/i.test(text),
      hasRefreshToken: /refresh/i.test(text),
    };
  });
}

function isLikelyLoginRequest(request: Request): boolean {
  if (request.method() === 'GET') return false;
  const combined = `${request.url()} ${request.postData() ?? ''}`;
  return /login|auth|signin|ingresar|usuario|password|passwd|pwd/i.test(combined);
}

function isYokomitsuUrl(value: string): boolean {
  try {
    return new URL(value).hostname.replace(/^www\./, '') === 'yokomitsuparts.com.uy';
  } catch {
    return false;
  }
}

function addProduct(products: Map<string, ProductRecord>, product: ProductRecord): void {
  if (products.size >= YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS) return;
  const key = product.sourceUrl ?? product.sku ?? product.productName;
  if (key && !products.has(key)) products.set(key, product);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(authorization|cookie|token|password|pass)=([^&\s]+)/gi, '$1=[REDACTED]');
}

function printReport(): void {
  console.log(JSON.stringify(report, null, 2));
}

void main();
