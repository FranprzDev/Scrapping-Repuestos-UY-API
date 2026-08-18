import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildYokomitsuCatalogSearchBody,
  calculateYokomitsuTotalPages,
  createEmptyYokomitsuCheckpoint,
  runYokomitsuFullCatalog,
  sanitizeYokomitsuCheckpoint,
  yokomitsuProductDedupKey,
} from './yokomitsu-full';
import {
  YOKOMITSU_FRONT_COOKIE_NAME,
  YOKOMITSU_LOGIN_URL,
  YOKOMITSU_SEARCH_ENDPOINT,
} from './yokomitsu';
import {
  YOKOMITSU_HTTP_LOGIN_URL,
  YOKOMITSU_PROCESS_LOGIN_ENDPOINT,
  type YokomitsuHttpClient,
  type YokomitsuHttpResponse,
} from './yokomitsu-auth';

test('Yokomitsu full arma busqueda vacia global con register=12 page base 1 view=grid', () => {
  assert.equal(buildYokomitsuCatalogSearchBody(), [
    'id_category=',
    'id_subcategory=',
    'id_subsubcategory=',
    'option_filter=',
    'search=',
    'order=',
    'register=12',
    'page=1',
    'view=grid',
  ].join('&'));
});

test('Yokomitsu full calcula paginas completas incluyendo 170 / 12 => 15', () => {
  assert.equal(calculateYokomitsuTotalPages(170, 12), 15);
  assert.equal(calculateYokomitsuTotalPages(24, 12), 2);
  assert.equal(calculateYokomitsuTotalPages(25, 12), 3);
});

test('Yokomitsu full recorre busqueda vacia, ultima pagina parcial y no limita a 5 productos', async () => {
  const products = Array.from({ length: 13 }, (_, index) => ({
    sku: `YK-${String(index + 1).padStart(3, '0')}`,
    name: `Producto ${index + 1}`,
  }));
  const output: unknown[] = [];
  const checkpoints: unknown[] = [];
  const client = createFakeFullClient({
    totalResults: 13,
    pages: {
      1: products.slice(0, 12),
      2: products.slice(12),
    },
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    outputProduct: async (product) => { output.push(product); },
    onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); },
    retryDelayMs: 0,
  });

  assert.equal(result.emptySearchReturnedGlobalCatalog, true);
  assert.equal(result.discoveryMethod, 'empty-search-global');
  assert.equal(result.totalResults, 13);
  assert.equal(result.totalPages, 2);
  assert.equal(result.urlsDiscovered, 13);
  assert.equal(result.validProducts, 13);
  assert.equal(output.length, 13);
  assert.equal(checkpoints.length > 0, true);
});

test('Yokomitsu full detiene paginacion si una pagina valida queda vacia', async () => {
  const client = createFakeFullClient({
    totalResults: 36,
    pages: {
      1: [{ sku: 'YK-001', name: 'Producto 1' }],
      2: [],
      3: [{ sku: 'YK-003', name: 'Producto 3' }],
    },
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    retryDelayMs: 0,
  });

  assert.equal(result.pagesProcessed, 2);
  assert.equal(client.searchPages.includes(3), false);
});

test('Yokomitsu full deduplica por URL canonica y SKU', () => {
  assert.equal(yokomitsuProductDedupKey({
    productName: 'A',
    sourceUrl: 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/m/1/a?x=1#top',
    provider: 'Yokomitsu',
    extractedAt: '2026-08-18T00:00:00.000Z',
  }), 'url:https://www.yokomitsuparts.com.uy/v2/producto-detalle/m/1/a');
  assert.equal(yokomitsuProductDedupKey({
    productName: 'A',
    sku: ' yk-001 ',
    provider: 'Yokomitsu',
    extractedAt: '2026-08-18T00:00:00.000Z',
  }), 'sku:YK-001');
});

test('Yokomitsu full deduplica productos con mismo SKU aunque cambie la URL', async () => {
  const output: unknown[] = [];
  const client = createFakeFullClient({
    totalResults: 2,
    pages: {
      1: [
        { sku: 'YK-001', name: 'Producto Uno' },
        { sku: 'YK-001', name: 'Producto Uno duplicado' },
      ],
    },
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    outputProduct: async (product) => { output.push(product); },
    retryDelayMs: 0,
  });

  assert.equal(result.urlsDiscovered, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(output.length, 1);
});

test('Yokomitsu full aplica retry limitado ante 5xx', async () => {
  const client = createFakeFullClient({
    totalResults: 1,
    pages: { 1: [{ sku: 'YK-001', name: 'Producto 1' }] },
    failFirstCatalogStatus: 500,
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    retries: 1,
    retryDelayMs: 0,
  });

  assert.equal(result.validProducts, 1);
  assert.equal(client.catalogAttempts, 2);
});

test('Yokomitsu full renueva sesion vencida una sola vez', async () => {
  const client = createFakeFullClient({
    totalResults: 1,
    pages: { 1: [{ sku: 'YK-001', name: 'Producto 1' }] },
    expireFirstCatalog: true,
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    retryDelayMs: 0,
  });

  assert.equal(result.sessionRenewed, true);
  assert.equal(client.loginPosts, 2);
  assert.equal(result.validProducts, 1);
});

test('Yokomitsu full sanitiza checkpoint sin secretos', () => {
  const checkpoint = sanitizeYokomitsuCheckpoint({
    ...createEmptyYokomitsuCheckpoint('2026-08-18T00:00:00.000Z'),
    discoveredProducts: [
      { sourceUrl: 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/a?x=1', sku: 'YK-001' },
      { sourceUrl: 'cookie:YOKOMITSU_FRONT=SECRET', sku: 'SECRET' },
    ],
    processedProductKeys: [
      'url:https://www.yokomitsuparts.com.uy/v2/producto-detalle/a',
      'cookie:YOKOMITSU_FRONT=SECRET',
      'auth_token=SECRET',
    ],
  });

  assert.deepEqual(checkpoint.processedProductKeys, [
    'url:https://www.yokomitsuparts.com.uy/v2/producto-detalle/a',
  ]);
  assert.deepEqual(checkpoint.discoveredProducts, [
    { sourceUrl: 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/a', sku: 'YK-001' },
  ]);
});

test('Yokomitsu full retoma fichas desde checkpoint sin repetir paginas completas', async () => {
  const output: unknown[] = [];
  const client = createFakeFullClient({
    totalResults: 1,
    pages: { 1: [{ sku: 'YK-001', name: 'Producto 1' }] },
  });
  const checkpoint = sanitizeYokomitsuCheckpoint({
    ...createEmptyYokomitsuCheckpoint('2026-08-18T00:00:00.000Z'),
    discoveryMethod: 'empty-search-global',
    completedPages: ['empty:1'],
    discoveredProducts: [{
      sourceUrl: 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/modelo/YK-001/producto-1',
      sku: 'YK-001',
    }],
  });

  const result = await runYokomitsuFullCatalog(client, {
    credentials: sanitizedCredentials(),
    checkpoint,
    outputProduct: async (product) => { output.push(product); },
    retryDelayMs: 0,
  });

  assert.equal(client.searchPages.length, 1);
  assert.equal(result.validProducts, 1);
  assert.equal(output.length, 1);
});

interface FakeFullOptions {
  totalResults: number;
  pages: Record<number, Array<{ sku: string; name: string }>>;
  failFirstCatalogStatus?: number;
  expireFirstCatalog?: boolean;
}

interface FakeFullClient extends YokomitsuHttpClient {
  searchPages: number[];
  catalogAttempts: number;
  loginPosts: number;
}

function createFakeFullClient(options: FakeFullOptions): FakeFullClient {
  let hasCookie = false;
  let catalogAttempts = 0;
  let loginPosts = 0;
  let expiredCatalogReturned = false;
  const searchPages: number[] = [];
  const client: FakeFullClient = {
    searchPages,
    get catalogAttempts() { return catalogAttempts; },
    get loginPosts() { return loginPosts; },
    get: async (url) => {
      if (url === YOKOMITSU_HTTP_LOGIN_URL) {
        hasCookie = true;
        return response(url, loginHtml(), { 'set-cookie': `${YOKOMITSU_FRONT_COOKIE_NAME}=REDACTED; Path=/; Secure` });
      }
      if (url === YOKOMITSU_LOGIN_URL) return response(url, portalHtml());
      return response(url, detailHtml(url));
    },
    post: async (url, body) => {
      if (url === YOKOMITSU_PROCESS_LOGIN_ENDPOINT) {
        loginPosts += 1;
        return response(url, '{"error":false,"message":"success"}');
      }
      if (url !== YOKOMITSU_SEARCH_ENDPOINT) throw new Error(`unexpected POST ${url}`);
      catalogAttempts += 1;
      if (options.failFirstCatalogStatus && catalogAttempts === 1) {
        return response(url, '', {}, options.failFirstCatalogStatus);
      }
      if (options.expireFirstCatalog && !expiredCatalogReturned) {
        expiredCatalogReturned = true;
        return response(YOKOMITSU_LOGIN_URL, expiredHtml());
      }
      assert.equal(hasCookie, true);
      const page = Number(new URLSearchParams(body).get('page') ?? '1');
      searchPages.push(page);
      return response(url, searchJson(options.totalResults, options.pages[page] ?? []));
    },
    getCookieNames: async () => hasCookie ? [YOKOMITSU_FRONT_COOKIE_NAME] : [],
    clearSession: async () => {
      hasCookie = false;
    },
  };
  return client;
}

function sanitizedCredentials() {
  return { username: 'SANITIZED_RUT', password: 'SANITIZED_PASSWORD' };
}

function response(
  url: string,
  body: string,
  headers: Record<string, string | string[] | undefined> = {},
  status = 200,
): YokomitsuHttpResponse {
  return { url, status, headers, body };
}

function loginHtml(): string {
  return '<form id="formLogin"><input name="rut"><input type="password" name="password"><input type="hidden" name="auth_token" value="SANITIZED_AUTH_TOKEN"></form>';
}

function portalHtml(): string {
  return '<section class="catalogo"><article class="producto">Portal</article></section>';
}

function expiredHtml(): string {
  return '<form id="formLogin"><input type="password" name="password"><input name="auth_token" value="SANITIZED_AUTH_TOKEN_2"></form>';
}

function searchJson(total: number, products: Array<{ sku: string; name: string }>): string {
  return JSON.stringify({
    error: false,
    number_register: total,
    data: products.map((product) => `
      <article class="producto" data-codprod="${product.sku}">
        <a href="/v2/producto-detalle/modelo/${encodeURIComponent(product.name)}/${product.sku}/${product.name.toLowerCase().replace(/\s+/g, '-')}">${product.name}</a>
        <span>Cód. Yokomitsu: ${product.sku}</span>
        <span class="precio">$3.406 +IVA</span>
      </article>
    `).join(''),
    pagination: '',
    text_pagination: '',
  });
}

function detailHtml(url: string): string {
  const sku = url.match(/(YK-\d+)/)?.[1] ?? 'YK-DETAIL';
  return `
    <article class="producto" data-codprod="${sku}">
      <h1>Detalle ${sku}</h1>
      <span>Cód. Yokomitsu: ${sku}</span>
      <span>OEM: OEM-${sku}</span>
      <span>Procedencia: CHINA</span>
      <span>Stock Crítico</span>
      <span class="precio">$9.221 +IVA</span>
      <img src="/imagenes/${sku}.jpg">
    </article>
  `;
}
