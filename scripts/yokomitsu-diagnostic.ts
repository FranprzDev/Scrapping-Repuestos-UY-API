import 'dotenv/config';
import { chromium, type Page, type Request, type Response } from 'playwright';
import {
  closeYokomitsuSessionResources,
  extractFieldNamesFromBody,
  extractYokomitsuProductsFromJson,
  hasReachedYokomitsuPortal,
  hasYokomitsuManualLoginTimedOut,
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
import {
  collectYokomitsuCatalogLinks,
  detectYokomitsuCaptcha,
  detectYokomitsuTwoFactor,
  extractYokomitsuProductsFromDom,
  inspectYokomitsuStorage,
} from '../src/scraping/domain/yokomitsu-playwright';
import type { ProductRecord } from '../src/scraping/interfaces/scraping.types';

const args = parseArgs(process.argv.slice(2));
const manualLogin = args.has('manual-login');
const headed = args.has('headed') || manualLogin;
const USERNAME = process.env.YOKOMITSU_USERNAME;
const PASSWORD = process.env.YOKOMITSU_PASSWORD;
const TIMEOUT_MS = positiveInt(process.env.YOKOMITSU_DIAGNOSTIC_TIMEOUT_MS, 60_000);
const MANUAL_LOGIN_TIMEOUT_MS = positiveInt(args.get('manual-timeout-ms') ?? process.env.YOKOMITSU_MANUAL_LOGIN_TIMEOUT_MS, 300_000);
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
  if (!manualLogin && (!USERNAME || !PASSWORD)) {
    report.status = 'missing-env';
    report.notes.push('set YOKOMITSU_USERNAME and YOKOMITSU_PASSWORD or use --manual-login to run the authenticated diagnostic');
    printReport();
    return;
  }

  const browser = await chromium.launch({ headless: headed ? false : process.env.YOKOMITSU_HEADLESS !== 'false' });
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
  let authenticatedCatalogResponses = 0;

  page.on('request', (request) => {
    if (!isYokomitsuUrl(request.url())) return;
    const headers = request.headers();
    sawAuthorizationHeader ||= typeof headers.authorization === 'string' && headers.authorization.trim().length > 0;
    const likelyLoginRequest = isLikelyLoginRequest(request);
    const call: YokomitsuNetworkCall = {
      method: request.method(),
      url: sanitizeUrl(request.url()),
      resourceType: request.resourceType(),
      requestBody: likelyLoginRequest && manualLogin ? '[MANUAL_LOGIN_BODY_NOT_READ]' : sanitizeRequestBody(request.postData()),
    };
    requests.set(request, call);
    if (likelyLoginRequest && !manualLogin) {
      report.login.fieldNames = extractFieldNamesFromBody(request.postData());
      report.login.method = request.method();
      report.login.endpoint = sanitizeUrl(request.url());
    } else if (likelyLoginRequest) {
      report.login.method = request.method();
      report.login.endpoint = sanitizeUrl(request.url());
    }
  });

  page.on('response', (response) => {
    if (isLikelyYokomitsuCatalogUrl(response.url()) && response.status() >= 200 && response.status() < 400) {
      authenticatedCatalogResponses += 1;
    }
    void inspectResponse(response, requests, productSamples);
  });

  try {
    await page.goto(YOKOMITSU_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);

    report.captchaDetected = await detectYokomitsuCaptcha(page);
    if (report.captchaDetected && !manualLogin) {
      report.status = 'blocked';
      report.restrictions.push('CAPTCHA detected on login page; diagnostic stopped before submitting credentials');
      return;
    }

    if (manualLogin) {
      printManualLoginInstructions();
      const loggedIn = await waitForManualLogin(page, () => authenticatedCatalogResponses, MANUAL_LOGIN_TIMEOUT_MS);
      if (!loggedIn) {
        report.status = 'blocked';
        report.restrictions.push(`Manual login timeout after ${MANUAL_LOGIN_TIMEOUT_MS}ms`);
        return;
      }
    } else {
      const filled = await fillLoginForm(page, USERNAME as string, PASSWORD as string);
      if (!filled) {
        report.status = 'blocked';
        report.restrictions.push('Could not identify username/password fields safely');
        return;
      }

      await submitLogin(page);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(1500);
    }

    report.captchaDetected = report.captchaDetected || await detectYokomitsuCaptcha(page);
    report.twoFactorDetected = await detectYokomitsuTwoFactor(page);
    report.reachedPortal = await hasReachedPortal(page, authenticatedCatalogResponses);
    report.authenticated = report.reachedPortal && !report.twoFactorDetected;

    const cookies = await context.cookies();
    report.login.usesSessionCookie = cookies.some((cookie) => /session|sess|sid|php|laravel|ci_session|connect/i.test(cookie.name)) || cookies.length > 0;
    const storageSignals = await inspectYokomitsuStorage(page);
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

    const domProducts = await extractYokomitsuProductsFromDom(page);
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
    await closeYokomitsuSessionResources({ context, browser }).catch(() => undefined);
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
  const candidateUrls = await collectYokomitsuCatalogLinks(page);

  for (const href of candidateUrls) {
    try {
      await page.goto(href, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
    } catch {
      // Continue probing other safe catalog-looking links.
    }
  }
}

async function hasReachedPortal(page: Page, authenticatedCatalogResponses: number): Promise<boolean> {
  const url = page.url();
  const hasPassword = await page.locator('input[type="password"]').count().catch(() => 1);
  const portalElementCount = await page.locator([
    'a[href*="logout" i]',
    'a[href*="salir" i]',
    '[class*="catalog" i]',
    '[class*="catalogo" i]',
    '[class*="producto" i]',
    '[class*="stock" i]',
    '[class*="precio" i]',
    'table',
  ].join(', ')).count().catch(() => 0);
  return hasReachedYokomitsuPortal({
    currentUrl: url,
    hasPasswordInput: hasPassword > 0,
    portalElementCount,
    authenticatedCatalogResponses,
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

async function waitForManualLogin(page: Page, catalogResponses: () => number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (!hasYokomitsuManualLoginTimedOut(started, Date.now(), timeoutMs)) {
    if (await hasReachedPortal(page, catalogResponses())) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

function printManualLoginInstructions(): void {
  console.log([
    'Yokomitsu manual diagnostic mode.',
    'A visible Chromium window is open at the login page.',
    'Please sign in manually, solve any CAPTCHA manually, and wait until the authenticated portal is loaded.',
    'The diagnostic will not type, read, print, or store your username, password, cookies, tokens, storage state, screenshots, HAR, or private HTML.',
    `Waiting up to ${MANUAL_LOGIN_TIMEOUT_MS}ms for the authenticated portal...`,
  ].join('\n'));
}

function parseArgs(values: string[]): Map<string, string> {
  return new Map(values.map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
    return [key, value];
  }));
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(authorization|cookie|token|password|pass)=([^&\s]+)/gi, '$1=[REDACTED]');
}

function printReport(): void {
  console.log(JSON.stringify(report, null, 2));
}

void main();
