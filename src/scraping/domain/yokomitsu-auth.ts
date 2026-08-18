import { parse } from 'node-html-parser';
import { cleanText } from './product-quality';
import {
  hasReachedYokomitsuPortal,
  YOKOMITSU_FRONT_COOKIE_NAME,
  YOKOMITSU_LOGIN_URL,
  YOKOMITSU_SEARCH_ENDPOINT,
} from './yokomitsu';

export const YOKOMITSU_HTTP_LOGIN_URL = 'https://www.yokomitsuparts.com.uy/v2/login';
export const YOKOMITSU_PROCESS_LOGIN_ENDPOINT = 'https://www.yokomitsuparts.com.uy/v2/ajax/process-login.php';
export const YOKOMITSU_DEFAULT_OFFICE = '0';
export const YOKOMITSU_DEFAULT_REMEMBER = '0';

const SENSITIVE_AUTH_KEY_PATTERN = /(rut|user|username|usuario|login|pass|password|passwd|pwd|auth_token|token|jwt|bearer|authorization|cookie|session|csrf|xsrf|secret)/i;

export interface YokomitsuCredentials {
  username: string;
  password: string;
  office?: string;
  remember?: string;
}

export interface YokomitsuHttpResponse {
  url: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface YokomitsuHttpClient {
  get: (url: string, headers?: Record<string, string>) => Promise<YokomitsuHttpResponse>;
  post: (url: string, body: string, headers?: Record<string, string>) => Promise<YokomitsuHttpResponse>;
  getCookieNames?: () => Promise<string[]>;
  clearSession?: () => Promise<unknown>;
}

export interface YokomitsuHttpLoginDiagnostic {
  loginGet: {
    httpStatus: number;
    finalUrl: string;
    setCookieNames: string[];
    cookieNamesBefore: string[];
    cookieNamesAfter: string[];
  };
  loginPost?: {
    httpStatus: number;
    finalUrl: string;
    sanitizedResponse: unknown;
    fieldNames: string[];
    cookieNamesBefore: string[];
    cookieNamesAfter: string[];
    responseErrorFalse: boolean;
  };
  homeGet?: {
    httpStatus: number;
    finalUrl: string;
    redirectedToLogin: boolean;
    sessionExpired: boolean;
    authenticated: boolean;
    cookieNamesBefore: string[];
    cookieNamesAfter: string[];
    cookieNamesAdded: string[];
    cookieNamesRemoved: string[];
    signals: YokomitsuHomeAuthenticationSignals;
    falseReason?: string;
  };
}

export interface YokomitsuHomeAuthenticationSignals {
  containsLoginForm: boolean;
  containsPasswordInput: boolean;
  containsAuthTokenField: boolean;
  containsProcessLoginReference: boolean;
  portalSignalNames: string[];
  portalElementCount: number;
  hasAuthenticatedPortalSignals: boolean;
}

export interface YokomitsuHttpLoginResult {
  authenticated: boolean;
  method: 'POST';
  endpoint: string;
  fieldNames: string[];
  usesSessionCookie: boolean;
  sessionCookieNames: string[];
  usesBearerToken: false;
  authorizationHeaderObserved: false;
  message?: string;
  status?: number;
  error?: string;
  diagnostic: YokomitsuHttpLoginDiagnostic;
}

export interface YokomitsuCatalogFetchOptions {
  body: string;
  credentials: YokomitsuCredentials;
  maxRelogins?: number;
}

export interface YokomitsuCatalogFetchResult {
  response: YokomitsuHttpResponse;
  loginAttempts: number;
  relogins: number;
  sessionExpired: boolean;
}

export function extractYokomitsuAuthTokenFromHtml(html: string): string | undefined {
  const root = parse(html);
  return cleanText(root.querySelector('input[name="auth_token"]')?.getAttribute('value') ?? undefined);
}

export function buildYokomitsuLoginForm(credentials: YokomitsuCredentials, authToken: string): URLSearchParams {
  return new URLSearchParams({
    rut: credentials.username,
    office: credentials.office ?? YOKOMITSU_DEFAULT_OFFICE,
    password: credentials.password,
    remember: credentials.remember ?? YOKOMITSU_DEFAULT_REMEMBER,
    auth_token: authToken,
  });
}

export function sanitizeYokomitsuAuthRequestBody(body: string | null | undefined): unknown {
  if (!body) return undefined;
  const params = new URLSearchParams(body);
  if (Array.from(params.keys()).length === 0) return '[NON_FORM_BODY_REDACTED]';
  return Object.fromEntries(Array.from(params.keys()).map((key) => [
    key,
    SENSITIVE_AUTH_KEY_PATTERN.test(key) ? '[REDACTED]' : '[VALUE]',
  ]));
}

export function parseYokomitsuLoginResponse(body: string): { success: boolean; message?: string; error?: unknown } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const message = typeof parsed.message === 'string' ? cleanText(parsed.message) : undefined;
    return {
      success: parsed.error === false && (message === 'success' || message === 'success-cart'),
      message,
      error: parsed.error,
    };
  } catch {
    return { success: false, error: 'invalid-login-response' };
  }
}

export async function authenticateYokomitsuHttpSession(
  client: YokomitsuHttpClient,
  credentials: YokomitsuCredentials,
): Promise<YokomitsuHttpLoginResult> {
  const cookieNamesBeforeLoginGet = await getSafeCookieNames(client);
  const loginPage = await client.get(YOKOMITSU_HTTP_LOGIN_URL, {
    accept: 'text/html,application/xhtml+xml',
  });
  const cookieNamesAfterLoginGet = await getSafeCookieNames(client);
  const sessionCookieNames = extractSetCookieNames(loginPage.headers)
    .filter((name) => name === YOKOMITSU_FRONT_COOKIE_NAME);
  const authToken = extractYokomitsuAuthTokenFromHtml(loginPage.body);
  const diagnostic: YokomitsuHttpLoginDiagnostic = {
    loginGet: {
      httpStatus: loginPage.status,
      finalUrl: sanitizeDiagnosticUrl(loginPage.url),
      setCookieNames: sessionCookieNames,
      cookieNamesBefore: cookieNamesBeforeLoginGet,
      cookieNamesAfter: cookieNamesAfterLoginGet,
    },
  };
  const baseResult = {
    method: 'POST' as const,
    endpoint: YOKOMITSU_PROCESS_LOGIN_ENDPOINT,
    fieldNames: ['rut', 'office', 'password', 'remember', 'auth_token'],
    usesSessionCookie: sessionCookieNames.includes(YOKOMITSU_FRONT_COOKIE_NAME),
    sessionCookieNames,
    usesBearerToken: false as const,
    authorizationHeaderObserved: false as const,
  };

  if (!authToken) {
    return {
      ...baseResult,
      authenticated: false,
      status: loginPage.status,
      error: 'auth_token missing from login page',
      diagnostic,
    };
  }

  const form = buildYokomitsuLoginForm(credentials, authToken);
  const cookieNamesBeforeLoginPost = await getSafeCookieNames(client);
  const loginResponse = await client.post(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, form.toString(), {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    origin: 'https://www.yokomitsuparts.com.uy',
    referer: YOKOMITSU_HTTP_LOGIN_URL,
    'x-requested-with': 'XMLHttpRequest',
  });
  const cookieNamesAfterLoginPost = await getSafeCookieNames(client);
  const parsed = parseYokomitsuLoginResponse(loginResponse.body);
  diagnostic.loginPost = {
    httpStatus: loginResponse.status,
    finalUrl: sanitizeDiagnosticUrl(loginResponse.url),
    sanitizedResponse: sanitizeYokomitsuLoginResponse(loginResponse.body),
    fieldNames: Array.from(buildYokomitsuLoginForm({
      username: '',
      password: '',
      office: credentials.office,
      remember: credentials.remember,
    }, '').keys()),
    cookieNamesBefore: cookieNamesBeforeLoginPost,
    cookieNamesAfter: cookieNamesAfterLoginPost,
    responseErrorFalse: parsed.error === false,
  };
  if (!parsed.success) {
    return {
      ...baseResult,
      authenticated: false,
      status: loginResponse.status,
      message: parsed.message,
      error: 'login rejected by process-login.php',
      diagnostic,
    };
  }

  const homeResponse = await client.get(YOKOMITSU_LOGIN_URL, {
    accept: 'text/html,application/xhtml+xml',
    referer: YOKOMITSU_HTTP_LOGIN_URL,
  });
  const cookieNamesBeforeHomeGet = cookieNamesAfterLoginPost;
  const homeSessionExpired = isYokomitsuSessionExpiredResponse(homeResponse);
  const homeSignals = analyzeYokomitsuHomeAuthentication(homeResponse.body);
  const cookieNamesAfterHomeGet = await getSafeCookieNames(client);
  const redirectedToLogin = isYokomitsuLoginUrl(homeResponse.url);
  const authenticated = !homeSessionExpired
    && hasReachedYokomitsuPortal({
      currentUrl: homeResponse.url,
      hasPasswordInput: homeSignals.containsPasswordInput,
      portalElementCount: homeSignals.portalElementCount,
      authenticatedCatalogResponses: 0,
      hasYokomitsuFrontCookie: cookieNamesAfterHomeGet.includes(YOKOMITSU_FRONT_COOKIE_NAME)
        || sessionCookieNames.includes(YOKOMITSU_FRONT_COOKIE_NAME),
    });
  diagnostic.homeGet = {
    httpStatus: homeResponse.status,
    finalUrl: sanitizeDiagnosticUrl(homeResponse.url),
    redirectedToLogin,
    sessionExpired: homeSessionExpired,
    authenticated,
    cookieNamesBefore: cookieNamesBeforeHomeGet,
    cookieNamesAfter: cookieNamesAfterHomeGet,
    cookieNamesAdded: diffCookieNames(cookieNamesAfterHomeGet, cookieNamesBeforeHomeGet),
    cookieNamesRemoved: diffCookieNames(cookieNamesBeforeHomeGet, cookieNamesAfterHomeGet),
    signals: homeSignals,
    falseReason: authenticated ? undefined : inferHomeAuthenticationFalseReason({
      redirectedToLogin,
      sessionExpired: homeSessionExpired,
      hasYokomitsuFrontCookie: cookieNamesAfterHomeGet.includes(YOKOMITSU_FRONT_COOKIE_NAME)
        || sessionCookieNames.includes(YOKOMITSU_FRONT_COOKIE_NAME),
      signals: homeSignals,
    }),
  };
  return {
    ...baseResult,
    authenticated,
    status: homeResponse.status,
    message: parsed.message,
    error: authenticated ? undefined : 'home did not confirm authenticated portal',
    diagnostic,
  };
}

export async function fetchYokomitsuCatalogWithSession(
  client: YokomitsuHttpClient,
  options: YokomitsuCatalogFetchOptions,
): Promise<YokomitsuCatalogFetchResult> {
  const maxRelogins = options.maxRelogins ?? 1;
  let loginAttempts = 0;
  let relogins = 0;

  const login = async () => {
    loginAttempts += 1;
    const result = await authenticateYokomitsuHttpSession(client, options.credentials);
    if (!result.authenticated) throw new Error(result.error ?? 'Yokomitsu login failed');
  };

  await login();
  let response = await postYokomitsuCatalog(client, options.body);
  let sessionExpired = isYokomitsuSessionExpiredResponse(response);
  while (sessionExpired && relogins < maxRelogins) {
    relogins += 1;
    await login();
    response = await postYokomitsuCatalog(client, options.body);
    sessionExpired = isYokomitsuSessionExpiredResponse(response);
  }

  return { response, loginAttempts, relogins, sessionExpired };
}

export async function withYokomitsuHttpSession<T>(
  client: YokomitsuHttpClient,
  credentials: YokomitsuCredentials,
  callback: (login: YokomitsuHttpLoginResult) => Promise<T>,
): Promise<T> {
  try {
    const login = await authenticateYokomitsuHttpSession(client, credentials);
    if (!login.authenticated) throw new Error(login.error ?? 'Yokomitsu login failed');
    return await callback(login);
  } finally {
    await client.clearSession?.();
  }
}

export function extractSetCookieNames(headers: Record<string, string | string[] | undefined>): string[] {
  const raw = Object.entries(headers)
    .filter(([key]) => /^set-cookie$/i.test(key))
    .flatMap(([, value]) => Array.isArray(value) ? value : value ? [value] : []);
  return Array.from(new Set(raw
    .flatMap((value) => value.split(/,(?=\s*[^;,=\s]+=[^;]+)/))
    .map((cookie) => cleanText(cookie.split(';')[0]?.split('=')[0]))
    .filter((name): name is string => Boolean(name))));
}

export function isYokomitsuSessionExpiredResponse(response: YokomitsuHttpResponse): boolean {
  if (isYokomitsuLoginUrl(response.url)) return true;
  if (response.status >= 300 && response.status < 400) {
    const location = Object.entries(response.headers)
      .find(([key]) => /^location$/i.test(key))?.[1];
    const locationText = Array.isArray(location) ? location.join(' ') : location;
    if (locationText && /\/v2\/login/i.test(locationText)) return true;
  }
  return isYokomitsuLoginHtml(response.body);
}

export function analyzeYokomitsuHomeAuthentication(html: string): YokomitsuHomeAuthenticationSignals {
  const root = parse(html);
  const containsPasswordInput = root.querySelectorAll('input[type="password"], input[name="password"]').length > 0;
  const containsAuthTokenField = root.querySelectorAll('input[name="auth_token"]').length > 0;
  const containsProcessLoginReference = /process-login\.php/i.test(html);
  const containsLoginForm = root.querySelectorAll([
    'form#formLogin',
    'form[action*="process-login.php" i]',
    'form input[name="rut"]',
    'form input[name="password"]',
  ].join(', ')).length > 0;
  const signalSelectors: Array<[string, string]> = [
    ['logout-link', 'a[href*="logout" i], a[href*="salir" i]'],
    ['catalog-link', 'a[href*="catalog" i], a[href*="catalogo" i]'],
    ['product-link', 'a[href*="producto" i], a[href*="productos" i]'],
    ['catalog-container', '[class*="catalog" i], [class*="catalogo" i]'],
    ['product-container', '[class*="producto" i], [class*="repuesto" i]'],
    ['price-container', '[class*="precio" i]'],
    ['stock-container', '[class*="stock" i]'],
    ['search-endpoint-reference', 'form[action*="load-data-search.php" i]'],
  ];
  const portalSignalNames = signalSelectors
    .filter(([, selector]) => root.querySelectorAll(selector).length > 0)
    .map(([name]) => name);
  if (/load-data-search\.php/i.test(html)) portalSignalNames.push('search-endpoint-reference');
  const uniqueSignalNames = Array.from(new Set(portalSignalNames)).sort();
  const portalElementCount = uniqueSignalNames.length;
  return {
    containsLoginForm,
    containsPasswordInput,
    containsAuthTokenField,
    containsProcessLoginReference,
    portalSignalNames: uniqueSignalNames,
    portalElementCount,
    hasAuthenticatedPortalSignals: portalElementCount > 0,
  };
}

async function postYokomitsuCatalog(client: YokomitsuHttpClient, body: string): Promise<YokomitsuHttpResponse> {
  return client.post(YOKOMITSU_SEARCH_ENDPOINT, body, {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'x-requested-with': 'XMLHttpRequest',
  });
}

function isYokomitsuLoginHtml(body: string): boolean {
  const signals = analyzeYokomitsuHomeAuthentication(body);
  return signals.containsLoginForm && signals.containsPasswordInput;
}

async function getSafeCookieNames(client: YokomitsuHttpClient): Promise<string[]> {
  if (!client.getCookieNames) return [];
  return client.getCookieNames()
    .then((names) => Array.from(new Set(names.filter(Boolean))).sort())
    .catch(() => []);
}

function sanitizeYokomitsuLoginResponse(body: string): unknown {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      error: parsed.error,
      message: typeof parsed.message === 'string' ? cleanText(parsed.message) : undefined,
    };
  } catch {
    return '[NON_JSON_LOGIN_RESPONSE_REDACTED]';
  }
}

function sanitizeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_AUTH_KEY_PATTERN.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return value.replace(/(authorization|cookie|auth_token|token|password|pass|rut)=([^&\s]+)/gi, '$1=[REDACTED]');
  }
}

function isYokomitsuLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /\/v2\/login\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function diffCookieNames(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((name) => !rightSet.has(name)).sort();
}

function inferHomeAuthenticationFalseReason(input: {
  redirectedToLogin: boolean;
  sessionExpired: boolean;
  hasYokomitsuFrontCookie: boolean;
  signals: YokomitsuHomeAuthenticationSignals;
}): string {
  if (input.redirectedToLogin) return 'home redirected to login URL';
  if (input.signals.containsLoginForm && input.signals.containsPasswordInput) return 'home contains login form and password input';
  if (input.sessionExpired) return 'home matched session-expired response';
  if (!input.hasYokomitsuFrontCookie) return 'YOKOMITSU_FRONT cookie name not present after home';
  if (!input.signals.hasAuthenticatedPortalSignals) return 'home has session cookie but no authenticated portal structural signals';
  return 'home did not satisfy authenticated portal detector';
}
