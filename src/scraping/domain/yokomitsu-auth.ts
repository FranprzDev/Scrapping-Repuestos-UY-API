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
  clearSession?: () => Promise<unknown>;
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
  const loginPage = await client.get(YOKOMITSU_HTTP_LOGIN_URL, {
    accept: 'text/html,application/xhtml+xml',
  });
  const sessionCookieNames = extractSetCookieNames(loginPage.headers)
    .filter((name) => name === YOKOMITSU_FRONT_COOKIE_NAME);
  const authToken = extractYokomitsuAuthTokenFromHtml(loginPage.body);
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
    };
  }

  const form = buildYokomitsuLoginForm(credentials, authToken);
  const loginResponse = await client.post(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, form.toString(), {
    'content-type': 'application/x-www-form-urlencoded',
    'x-requested-with': 'XMLHttpRequest',
  });
  const parsed = parseYokomitsuLoginResponse(loginResponse.body);
  if (!parsed.success) {
    return {
      ...baseResult,
      authenticated: false,
      status: loginResponse.status,
      message: parsed.message,
      error: 'login rejected by process-login.php',
    };
  }

  const homeResponse = await client.get(YOKOMITSU_LOGIN_URL, {
    accept: 'text/html,application/xhtml+xml',
  });
  const authenticated = !isYokomitsuSessionExpiredResponse(homeResponse)
    && hasReachedYokomitsuPortal({
      currentUrl: homeResponse.url,
      hasPasswordInput: false,
      portalElementCount: 1,
      authenticatedCatalogResponses: 0,
      hasYokomitsuFrontCookie: sessionCookieNames.includes(YOKOMITSU_FRONT_COOKIE_NAME),
    });
  return {
    ...baseResult,
    authenticated,
    status: homeResponse.status,
    message: parsed.message,
    error: authenticated ? undefined : 'home did not confirm authenticated portal',
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
  try {
    const url = new URL(response.url);
    if (/\/v2\/login\/?$/i.test(url.pathname)) return true;
  } catch {
    // Continue with body checks for non-URL test fixtures.
  }
  if (response.status >= 300 && response.status < 400) {
    const location = Object.entries(response.headers)
      .find(([key]) => /^location$/i.test(key))?.[1];
    const locationText = Array.isArray(location) ? location.join(' ') : location;
    if (locationText && /\/v2\/login/i.test(locationText)) return true;
  }
  return isYokomitsuLoginHtml(response.body);
}

async function postYokomitsuCatalog(client: YokomitsuHttpClient, body: string): Promise<YokomitsuHttpResponse> {
  return client.post(YOKOMITSU_SEARCH_ENDPOINT, body, {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'x-requested-with': 'XMLHttpRequest',
  });
}

function isYokomitsuLoginHtml(body: string): boolean {
  const text = body.toLowerCase();
  return /name=["']password["']|type=["']password["']|process-login\.php|formlogin|auth_token/.test(text);
}
