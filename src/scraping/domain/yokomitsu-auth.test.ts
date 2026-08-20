import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeYokomitsuHomeAuthentication,
  authenticateYokomitsuHttpSession,
  buildYokomitsuLoginForm,
  extractSetCookieNames,
  extractYokomitsuAuthTokenFromHtml,
  fetchYokomitsuCatalogWithSession,
  isYokomitsuSessionExpiredResponse,
  parseYokomitsuLoginResponse,
  sanitizeYokomitsuAuthRequestBody,
  withYokomitsuHttpSession,
  YOKOMITSU_HTTP_LOGIN_URL,
  YOKOMITSU_PROCESS_LOGIN_ENDPOINT,
  type YokomitsuHttpClient,
  type YokomitsuHttpResponse,
} from './yokomitsu-auth';
import {
  hasVisibleYokomitsuCaptchaChallenge,
  YOKOMITSU_FRONT_COOKIE_NAME,
  YOKOMITSU_LOGIN_URL,
  YOKOMITSU_SEARCH_ENDPOINT,
} from './yokomitsu';

test('Yokomitsu extrae auth_token hidden y nombres de Set-Cookie sin valores', () => {
  const fixture = readYokomitsuLoginFixture();
  assert.equal(extractYokomitsuAuthTokenFromHtml(fixture.loginHtml), 'SANITIZED_AUTH_TOKEN');
  assert.equal(extractYokomitsuAuthTokenFromHtml(fixture.loginHtmlWithoutToken), undefined);
  assert.deepEqual(extractSetCookieNames({
    'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
  }), [YOKOMITSU_FRONT_COOKIE_NAME]);
});

test('Yokomitsu arma login HTTP con campos reales y redaccion segura', () => {
  const form = buildYokomitsuLoginForm({
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  }, 'SANITIZED_AUTH_TOKEN');

  assert.deepEqual(Array.from(form.keys()), ['rut', 'office', 'password', 'remember', 'auth_token']);
  assert.equal(form.get('office'), '0');
  assert.equal(form.get('remember'), '0');
  assert.deepEqual(sanitizeYokomitsuAuthRequestBody(form.toString()), {
    rut: '[REDACTED]',
    office: '[VALUE]',
    password: '[REDACTED]',
    remember: '[VALUE]',
    auth_token: '[REDACTED]',
  });
});

test('Yokomitsu interpreta respuestas success y error de process-login.php', () => {
  const fixture = readYokomitsuLoginFixture();
  assert.deepEqual(parseYokomitsuLoginResponse(fixture.loginSuccess), {
    success: true,
    message: 'success',
    error: false,
  });
  assert.deepEqual(parseYokomitsuLoginResponse('{"error":false,"message":"success-cart"}'), {
    success: true,
    message: 'success-cart',
    error: false,
  });
  assert.deepEqual(parseYokomitsuLoginResponse(fixture.loginError), {
    success: false,
    message: 'invalid credentials',
    error: true,
  });
});

test('Yokomitsu login HTTP reutiliza YOKOMITSU_FRONT y valida home autenticado', async () => {
  const fixture = readYokomitsuLoginFixture();
  const calls: FakeYokomitsuCall[] = [];
  const client = createFakeYokomitsuClient(calls, [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, {
      'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
    }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, fixture.portalHtml),
  ]);

  const result = await authenticateYokomitsuHttpSession(client, {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.method, 'POST');
  assert.equal(result.endpoint, YOKOMITSU_PROCESS_LOGIN_ENDPOINT);
  assert.deepEqual(result.fieldNames, ['rut', 'office', 'password', 'remember', 'auth_token']);
  assert.equal(result.usesSessionCookie, true);
  assert.deepEqual(result.sessionCookieNames, [YOKOMITSU_FRONT_COOKIE_NAME]);
  assert.equal(result.usesBearerToken, false);
  assert.equal(result.authorizationHeaderObserved, false);
  assert.deepEqual(result.diagnostic.loginGet.cookieNamesBefore, []);
  assert.deepEqual(result.diagnostic.loginGet.cookieNamesAfter, [YOKOMITSU_FRONT_COOKIE_NAME]);
  assert.deepEqual(result.diagnostic.loginPost?.cookieNamesBefore, [YOKOMITSU_FRONT_COOKIE_NAME]);
  assert.deepEqual(result.diagnostic.loginPost?.cookieNamesAfter, [YOKOMITSU_FRONT_COOKIE_NAME]);
  assert.deepEqual(result.diagnostic.loginPost?.sanitizedResponse, {
    error: false,
    message: 'success',
  });
  assert.equal(result.diagnostic.loginPost?.responseErrorFalse, true);
  assert.equal(result.diagnostic.homeGet?.httpStatus, 200);
  assert.equal(result.diagnostic.homeGet?.authenticated, true);
  assert.equal(result.diagnostic.homeGet?.redirectedToLogin, false);
  assert.equal(result.diagnostic.homeGet?.sessionExpired, false);
  assert.deepEqual(result.diagnostic.homeGet?.cookieNamesBefore, [YOKOMITSU_FRONT_COOKIE_NAME]);
  assert.deepEqual(result.diagnostic.homeGet?.cookieNamesAfter, [YOKOMITSU_FRONT_COOKIE_NAME]);
  assert.deepEqual(result.diagnostic.homeGet?.cookieNamesAdded, []);
  assert.deepEqual(result.diagnostic.homeGet?.cookieNamesRemoved, []);
  assert.equal(result.diagnostic.homeGet?.signals.containsLoginForm, false);
  assert.equal(result.diagnostic.homeGet?.signals.containsPasswordInput, false);
  assert.equal(result.diagnostic.homeGet?.signals.hasAuthenticatedPortalSignals, true);
  assert.equal(result.diagnostic.homeGet?.falseReason, undefined);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    `GET ${YOKOMITSU_HTTP_LOGIN_URL}`,
    `POST ${YOKOMITSU_PROCESS_LOGIN_ENDPOINT}`,
    `GET ${YOKOMITSU_LOGIN_URL}`,
  ]);
  assert.deepEqual(sanitizeYokomitsuAuthRequestBody(calls[1].body), {
    rut: '[REDACTED]',
    office: '[VALUE]',
    password: '[REDACTED]',
    remember: '[VALUE]',
    auth_token: '[REDACTED]',
  });
});

test('Yokomitsu POST HTTP usa headers equivalentes al XHR real sin valores sensibles', async () => {
  const fixture = readYokomitsuLoginFixture();
  const calls: FakeYokomitsuCall[] = [];
  const client = createFakeYokomitsuClient(calls, [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, {
      'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
    }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, fixture.portalHtml),
  ]);

  await authenticateYokomitsuHttpSession(client, {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  });

  const post = calls.find((call) => call.method === 'POST' && call.url === YOKOMITSU_PROCESS_LOGIN_ENDPOINT);
  assert.ok(post);
  assert.equal(post.headers?.accept, 'application/json, text/javascript, */*; q=0.01');
  assert.equal(post.headers?.['content-type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(post.headers?.origin, 'https://www.yokomitsuparts.com.uy');
  assert.equal(post.headers?.referer, YOKOMITSU_HTTP_LOGIN_URL);
  assert.equal(post.headers?.['x-requested-with'], 'XMLHttpRequest');
  assert.equal(JSON.stringify(post.headers).includes('SANITIZED_PASSWORD'), false);
  assert.equal(JSON.stringify(post.headers).includes('SANITIZED_AUTH_TOKEN'), false);
  assert.equal(JSON.stringify(post.headers).includes('YOKOMITSU_FRONT='), false);
});

test('Yokomitsu login HTTP falla claramente si auth_token falta o el login responde error', async () => {
  const fixture = readYokomitsuLoginFixture();
  const missingToken = await authenticateYokomitsuHttpSession(createFakeYokomitsuClient([], [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtmlWithoutToken, {
      'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
    }),
  ]), {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  });
  assert.equal(missingToken.authenticated, false);
  assert.match(missingToken.error ?? '', /auth_token missing/);

  const rejected = await authenticateYokomitsuHttpSession(createFakeYokomitsuClient([], [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, {
      'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
    }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginError),
  ]), {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  });
  assert.equal(rejected.authenticated, false);
  assert.match(rejected.error ?? '', /login rejected/);
});

test('Yokomitsu detecta sesion vencida por redirect, HTML de login o home no autenticado', () => {
  const fixture = readYokomitsuLoginFixture();
  assert.equal(isYokomitsuSessionExpiredResponse(response('https://www.yokomitsuparts.com.uy/v2/login', fixture.expiredHtml)), true);
  assert.equal(isYokomitsuSessionExpiredResponse(response(YOKOMITSU_SEARCH_ENDPOINT, '', {
    location: '/v2/login',
  }, 302)), true);
  assert.equal(isYokomitsuSessionExpiredResponse(response(YOKOMITSU_SEARCH_ENDPOINT, fixture.expiredHtml)), true);
  assert.equal(isYokomitsuSessionExpiredResponse(response(YOKOMITSU_SEARCH_ENDPOINT, '{"error":false,"data":"<article></article>"}')), false);
});

test('Yokomitsu home autenticado con auth_token no se clasifica como login si no hay password', async () => {
  const fixture = readYokomitsuLoginFixture();
  const authenticatedHomeWithToken = [
    '<html><body>',
    '<input type="hidden" name="auth_token" value="SANITIZED_AUTH_TOKEN_2">',
    '<script>var endpoint = "/v2/ajax/process-login.php";</script>',
    '<nav><a href="/v2/salir">Salir</a></nav>',
    '<section class="catalogo"><article class="producto">Producto sanitizado</article></section>',
    '<form action="/v2/ajax/load-data-search.php"></form>',
    '</body></html>',
  ].join('');
  const calls: FakeYokomitsuCall[] = [];
  const client = createFakeYokomitsuClient(calls, [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, {
      'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
    }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, authenticatedHomeWithToken),
  ]);

  const result = await authenticateYokomitsuHttpSession(client, {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  });

  assert.equal(isYokomitsuSessionExpiredResponse(response(YOKOMITSU_LOGIN_URL, authenticatedHomeWithToken)), false);
  assert.equal(result.authenticated, true);
  assert.equal(result.diagnostic.homeGet?.signals.containsAuthTokenField, true);
  assert.equal(result.diagnostic.homeGet?.signals.containsProcessLoginReference, true);
  assert.equal(result.diagnostic.homeGet?.signals.containsLoginForm, false);
  assert.equal(result.diagnostic.homeGet?.signals.containsPasswordInput, false);
  assert.deepEqual(result.diagnostic.homeGet?.signals.portalSignalNames, [
    'catalog-container',
    'logout-link',
    'product-container',
    'search-endpoint-reference',
  ]);
});

test('Yokomitsu home con formulario password queda diagnosticado como no autenticado', async () => {
  const fixture = readYokomitsuLoginFixture();
  const calls: FakeYokomitsuCall[] = [];
  const client = createFakeYokomitsuClient(calls, [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, {
      'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure`,
    }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, fixture.expiredHtml),
  ]);

  const result = await authenticateYokomitsuHttpSession(client, {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  });

  assert.equal(result.authenticated, false);
  assert.equal(result.diagnostic.homeGet?.signals.containsLoginForm, true);
  assert.equal(result.diagnostic.homeGet?.signals.containsPasswordInput, true);
  assert.equal(result.diagnostic.homeGet?.falseReason, 'home contains login form and password input');
});

test('Yokomitsu resume senales estructurales de home sin exponer HTML privado', () => {
  const signals = analyzeYokomitsuHomeAuthentication([
    '<html><body>',
    '<input type="hidden" name="auth_token" value="SANITIZED_AUTH_TOKEN">',
    '<nav><a href="/v2/salir">Salir</a></nav>',
    '<div class="precio"></div>',
    '<div class="stock"></div>',
    '<section class="catalogo"></section>',
    '</body></html>',
  ].join(''));

  assert.equal(signals.containsAuthTokenField, true);
  assert.equal(signals.containsLoginForm, false);
  assert.equal(signals.containsPasswordInput, false);
  assert.deepEqual(signals.portalSignalNames, [
    'catalog-container',
    'logout-link',
    'price-container',
    'stock-container',
  ]);
});

test('Yokomitsu re-login controlado ocurre como maximo una vez por ejecucion', async () => {
  const fixture = readYokomitsuLoginFixture();
  const calls: FakeYokomitsuCall[] = [];
  const client = createFakeYokomitsuClient(calls, [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, { 'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure` }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, fixture.portalHtml),
    response(YOKOMITSU_SEARCH_ENDPOINT, fixture.expiredHtml),
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, { 'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure` }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, fixture.portalHtml),
    response(YOKOMITSU_SEARCH_ENDPOINT, fixture.expiredHtml),
  ]);

  const result = await fetchYokomitsuCatalogWithSession(client, {
    body: 'search=CREMALLERA&register=12&view=grid',
    credentials: {
      username: 'SANITIZED_RUT',
      password: 'SANITIZED_PASSWORD',
    },
    maxRelogins: 1,
  });

  assert.equal(result.loginAttempts, 2);
  assert.equal(result.relogins, 1);
  assert.equal(result.sessionExpired, true);
  assert.equal(calls.filter((call) => call.url === YOKOMITSU_PROCESS_LOGIN_ENDPOINT).length, 2);
  assert.equal(calls.filter((call) => call.url === YOKOMITSU_SEARCH_ENDPOINT).length, 2);
});

test('Yokomitsu limpia la sesion HTTP en finally', async () => {
  const fixture = readYokomitsuLoginFixture();
  const calls: FakeYokomitsuCall[] = [];
  const client = createFakeYokomitsuClient(calls, [
    response(YOKOMITSU_HTTP_LOGIN_URL, fixture.loginHtml, { 'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure` }),
    response(YOKOMITSU_PROCESS_LOGIN_ENDPOINT, fixture.loginSuccess),
    response(YOKOMITSU_LOGIN_URL, fixture.portalHtml),
  ]);

  await assert.rejects(() => withYokomitsuHttpSession(client, {
    username: 'SANITIZED_RUT',
    password: 'SANITIZED_PASSWORD',
  }, async () => {
    throw new Error('diagnostic failed after login');
  }), /diagnostic failed/);
  assert.equal(calls.at(-1)?.method, 'CLEAR');
});

test('Yokomitsu CAPTCHA script no visible no bloquea, visible si bloquea automatico', () => {
  assert.equal(hasVisibleYokomitsuCaptchaChallenge([{
    tagName: 'script',
    src: 'https://www.google.com/recaptcha/api.js',
    visible: false,
  }]), false);
  assert.equal(hasVisibleYokomitsuCaptchaChallenge([{
    tagName: 'iframe',
    title: 'reCAPTCHA',
    src: 'https://www.google.com/recaptcha/api2/anchor',
    visible: true,
  }]), true);
});

function readYokomitsuFixture(name: string): string {
  return readFileSync(join(process.cwd(), 'src', 'scraping', 'domain', 'fixtures', 'yokomitsu', name), 'utf8');
}

function readYokomitsuLoginFixture(): Record<string, string> {
  return JSON.parse(readYokomitsuFixture('login-flow.json')) as Record<string, string>;
}

function response(
  url: string,
  body: string,
  headers: Record<string, string | string[] | undefined> = {},
  status = 200,
): YokomitsuHttpResponse {
  return { url, status, headers, body };
}

interface FakeYokomitsuCall {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
}

function createFakeYokomitsuClient(
  calls: FakeYokomitsuCall[],
  responses: YokomitsuHttpResponse[],
): YokomitsuHttpClient {
  let hasYokomitsuFront = false;
  return {
    get: async (url, headers) => {
      calls.push({ method: 'GET', url, headers });
      const next = responses.shift();
      if (!next) throw new Error(`missing fake response for GET ${url}`);
      if (extractSetCookieNames(next.headers).includes(YOKOMITSU_FRONT_COOKIE_NAME)) hasYokomitsuFront = true;
      return next;
    },
    post: async (url, body, headers) => {
      calls.push({ method: 'POST', url, body, headers });
      const next = responses.shift();
      if (!next) throw new Error(`missing fake response for POST ${url}`);
      return next;
    },
    getCookieNames: async () => hasYokomitsuFront ? [YOKOMITSU_FRONT_COOKIE_NAME] : [],
    clearSession: async () => {
      calls.push({ method: 'CLEAR', url: 'session' });
    },
  };
}
