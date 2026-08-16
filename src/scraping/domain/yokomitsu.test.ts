import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeYokomitsuSessionResources,
  extractCookieNames,
  extractFieldNamesFromBody,
  extractYokomitsuProductsFromJson,
  hasReachedYokomitsuPortal,
  hasVisibleYokomitsuCaptchaChallenge,
  hasYokomitsuManualLoginTimedOut,
  inferApproximateProductCount,
  inferPaginationFromCalls,
  inferYokomitsuFieldsAvailable,
  isLikelyYokomitsuCatalogUrl,
  isYokomitsuSearchEndpoint,
  normalizeYokomitsuPrice,
  parseYokomitsuSearchRequestBody,
  parseYokomitsuSearchResponse,
  sanitizeHeaders,
  sanitizeRequestBody,
  sanitizeUrl,
  summarizeJsonShape,
  summarizeYokomitsuSearchAuth,
  YOKOMITSU_FRONT_COOKIE_NAME,
  YOKOMITSU_LEGACY_LOGIN_URL,
  YOKOMITSU_LOGIN_URL,
} from './yokomitsu';

test('Yokomitsu normaliza precios uruguayos sin afectar otros proveedores', () => {
  assert.equal(normalizeYokomitsuPrice('$ 1.234'), '1234');
  assert.equal(normalizeYokomitsuPrice('UYU 12.345'), '12345');
  assert.equal(normalizeYokomitsuPrice('$U 1.234,50'), '1234.50');
  assert.equal(normalizeYokomitsuPrice('123,45'), '123.45');
  assert.equal(normalizeYokomitsuPrice('$3.406 +IVA'), '3406');
  assert.equal(normalizeYokomitsuPrice('$9.221 +IVA'), '9221');
});

test('Yokomitsu redacta credenciales, cookies y tokens en requests', () => {
  assert.equal(
    sanitizeUrl('https://www.yokomitsuparts.com.uy/v2/api/catalogo?token=abc&page=2'),
    'https://www.yokomitsuparts.com.uy/v2/api/catalogo?token=%5BREDACTED%5D&page=2',
  );
  assert.deepEqual(sanitizeHeaders({
    authorization: 'Bearer secret',
    cookie: 'session=secret',
    'set-cookie': 'session=secret',
    accept: 'application/json',
  }), {
    authorization: '[REDACTED]',
    cookie: '[REDACTED]',
    'set-cookie': '[REDACTED]',
    accept: 'application/json',
  });
  assert.deepEqual(sanitizeRequestBody('usuario=demo&password=secret&empresa=abc'), {
    usuario: '[VALUE]',
    password: '[REDACTED]',
    empresa: '[VALUE]',
  });
  assert.deepEqual(extractFieldNamesFromBody('usuario=demo&password=secret'), ['usuario', 'password']);
});

test('Yokomitsu resume autenticacion observada del buscador sin valores sensibles', () => {
  const auth = summarizeYokomitsuSearchAuth({
    cookie: `${YOKOMITSU_FRONT_COOKIE_NAME}=redacted; other_cookie=redacted`,
    'x-requested-with': 'XMLHttpRequest',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  });

  assert.equal(auth.usesSessionCookie, true);
  assert.deepEqual(auth.cookieNames, [YOKOMITSU_FRONT_COOKIE_NAME]);
  assert.equal(auth.authorizationHeaderObserved, false);
  assert.equal(auth.usesBearerToken, false);
  assert.deepEqual(extractCookieNames(`${YOKOMITSU_FRONT_COOKIE_NAME}=redacted; analytics=redacted`), [
    YOKOMITSU_FRONT_COOKIE_NAME,
    'analytics',
  ]);
});

test('Yokomitsu extrae muestra desde JSON sanitizado de catalogo', () => {
  const body = {
    total: 1234,
    page: 1,
    data: [{
      codigo: 'YK-001',
      nombre: 'Filtro de aceite',
      marcaProducto: 'Marca Demo',
      precio: '1.234,50',
      moneda: 'UYU',
      stock: '7',
      referencia: 'REF-001',
      categoria: 'Filtros',
      marcaVehiculo: 'Toyota',
      modeloVehiculo: 'Corolla',
      imagen: '/img/filtro.jpg',
    }],
  };

  const products = extractYokomitsuProductsFromJson(body, 'https://www.yokomitsuparts.com.uy/v2/');
  assert.equal(products.length, 1);
  assert.equal(products[0].provider, 'Yokomitsu');
  assert.equal(products[0].productName, 'Filtro de aceite');
  assert.equal(products[0].sku, 'YK-001');
  assert.equal(products[0].price, '1234.50');
  assert.equal(products[0].currency, 'UYU');
  assert.equal(products[0].availability, 'in_stock');
  assert.equal(products[0].attributes?.referencia, 'REF-001');
  assert.equal(products[0].attributes?.vehicleBrand, 'Toyota');
  assert.equal(products[0].attributes?.vehicleModel, 'Corolla');
  assert.equal(products[0].imageUrl, 'https://www.yokomitsuparts.com.uy/img/filtro.jpg');
  assert.equal(inferApproximateProductCount(body), 1234);
});

test('Yokomitsu clasifica load-data-search.php como endpoint de catalogo y busqueda', () => {
  assert.equal(isYokomitsuSearchEndpoint('https://www.yokomitsuparts.com.uy/v2/ajax/load-data-search.php'), true);
  assert.equal(isLikelyYokomitsuCatalogUrl('https://www.yokomitsuparts.com.uy/v2/ajax/load-data-search.php'), true);
});

test('Yokomitsu interpreta requests de busqueda con pagina base uno y grilla', () => {
  const initial = parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12');
  const page2 = parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12&page=2&view=grid');
  const page3 = parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12&page=3&view=grid');

  assert.equal(initial.page, 1);
  assert.equal(initial.register, 12);
  assert.equal(page2.page, 2);
  assert.equal(page2.register, 12);
  assert.equal(page2.view, 'grid');
  assert.equal(page3.page, 3);
  assert.equal(page3.register, 12);
  assert.equal(page3.view, 'grid');
});

test('Yokomitsu parsea JSON servido como text/html y calcula paginacion confirmada', () => {
  const request = parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12&view=grid');
  const summary = parseYokomitsuSearchResponse(readYokomitsuFixture('search-page-1.json'), request);

  assert.ok(summary);
  assert.equal(summary.numberRegister, 170);
  assert.equal(summary.pageSize, 12);
  assert.equal(summary.currentPage, 1);
  assert.equal(summary.totalPages, 15);
  assert.equal(summary.textPagination, 'Visualización de 1 a 12 registros');
});

test('Yokomitsu respeta page=2 y page=3 en respuestas sanitizadas', () => {
  const page2 = parseYokomitsuSearchResponse(
    readYokomitsuFixture('search-page-2.json'),
    parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12&page=2&view=grid'),
  );
  const page3 = parseYokomitsuSearchResponse(
    readYokomitsuFixture('search-page-3.json'),
    parseYokomitsuSearchRequestBody('search=CREMALLERA&register=12&page=3&view=grid'),
  );

  assert.equal(page2?.currentPage, 2);
  assert.equal(page2?.pageSize, 12);
  assert.equal(page2?.totalPages, 15);
  assert.equal(page3?.currentPage, 3);
  assert.equal(page3?.pageSize, 12);
  assert.equal(page3?.totalPages, 15);
});

test('Yokomitsu extrae productos desde data HTML sin asumir stock por Comprar', () => {
  const products = extractYokomitsuProductsFromJson(JSON.parse(readYokomitsuFixture('search-page-1.json')));

  assert.equal(products.length, 2);
  assert.equal(products[0].productName, 'Cremallera direccion Toyota Corolla');
  assert.equal(products[0].sourceUrl, 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/toyota-corolla/1001/cremallera-direccion');
  assert.equal(products[0].sku, 'YK-001');
  assert.equal(products[0].brand, 'DemoBrand');
  assert.equal(products[0].attributes?.referencia, 'OEM-001');
  assert.equal(products[0].attributes?.vehicleModel, 'Corolla');
  assert.equal(products[0].attributes?.proximaLlegada, '20 dias');
  assert.equal(products[0].attributes?.procedencia, 'JP');
  assert.equal(products[0].price, '3406');
  assert.equal(products[0].currency, 'UYU');
  assert.equal(products[0].imageUrl, 'https://www.yokomitsuparts.com.uy/v2/img/yokomitsu/yok-001.jpg');
  assert.equal(products[0].availability, 'Stock Crítico');
  assert.equal(products[0].attributes?.stockStatus, 'Stock Crítico');
  assert.equal(products[0].stock, undefined);
  assert.equal(products[1].price, '9221');
  assert.equal(products[1].availability, 'out_of_stock');
  assert.equal(products[1].attributes?.stockStatus, 'out_of_stock');
  assert.equal(products[1].stock, undefined);
});

test('Yokomitsu corta campos etiquetados antes de otra etiqueta o estado', () => {
  const products = extractYokomitsuProductsFromJson(JSON.parse(readYokomitsuFixture('label-edge-cases.json')));

  assert.equal(products.length, 5);

  const withOem = products.find((product) => product.sku === 'YK-OEM-1');
  assert.equal(withOem?.attributes?.referencia, 'OEM-123');
  assert.equal(withOem?.attributes?.procedencia, 'CHINA');

  const emptyOem = products.find((product) => product.sku === 'YK-OEM-2');
  assert.equal(emptyOem?.attributes?.referencia, undefined);
  assert.equal(emptyOem?.attributes?.procedencia, 'CHINA');

  const critical = products.find((product) => product.sku === 'YK-STOCK-1');
  assert.equal(critical?.attributes?.procedencia, 'CHINA');
  assert.equal(critical?.availability, 'Stock Crítico');
  assert.equal(critical?.attributes?.stockStatus, 'Stock Crítico');
  assert.equal(critical?.stock, undefined);

  const procedenciaOnly = products.find((product) => product.sku === 'YK-PROC-1');
  assert.equal(procedenciaOnly?.attributes?.procedencia, 'BRASIL');
  assert.equal(procedenciaOnly?.availability, undefined);

  const emptyArrival = products.find((product) => product.sku === 'YK-ARR-1');
  assert.equal(emptyArrival?.attributes?.proximaLlegada, undefined);
  assert.equal(emptyArrival?.attributes?.procedencia, 'JAPÓN');
});

test('Yokomitsu separa estados negativos de disponibilidad sin capturarlos como labels', () => {
  const data = ['Sin stock', 'Agotado', 'No disponible'].map((status, index) => `
    <article class="producto" data-codprod="YK-NEG-${index + 1}">
      <a href="/v2/producto-detalle/demo/neg-${index + 1}/estado-${index + 1}"><h3>Pieza ${status}</h3></a>
      <span>Cód. Yokomitsu: YK-NEG-${index + 1}</span>
      <span>Marca: DemoBrand</span>
      <span>Modelo: Demo ${index + 1}</span>
      <span>OEM:</span>
      <span>Procedencia: CHINA</span>
      <span>${status}</span>
      <strong class="precio">$1.234 +IVA</strong>
    </article>
  `).join('');
  const products = extractYokomitsuProductsFromJson({ number_register: 3, data });

  assert.equal(products.length, 3);
  for (const product of products) {
    assert.equal(product.attributes?.referencia, undefined);
    assert.equal(product.attributes?.procedencia, 'CHINA');
    assert.equal(product.availability, 'out_of_stock');
    assert.equal(product.attributes?.stockStatus, 'out_of_stock');
  }
});

test('Yokomitsu no usa etiquetas conocidas como valores de otros campos', () => {
  const products = extractYokomitsuProductsFromJson({
    data: `
      <article class="producto" data-codprod="YK-LABEL-1">
        <a href="/v2/producto-detalle/demo/label/contaminacion"><h3>Pieza etiquetas</h3></a>
        <span>Cód. Yokomitsu: YK-LABEL-1</span>
        <span>Marca:</span>
        <span>Modelo: Demo Label</span>
        <span>OEM:</span>
        <span>Procedencia:</span>
        <span>Stock Crítico</span>
        <strong class="precio">$1.234 +IVA</strong>
      </article>
    `,
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].brand, undefined);
  assert.equal(products[0].attributes?.referencia, undefined);
  assert.equal(products[0].attributes?.procedencia, undefined);
  assert.equal(products[0].availability, 'Stock Crítico');
});

test('Yokomitsu resume shape, campos y paginacion sin guardar datos privados', () => {
  const shape = summarizeJsonShape({
    recordsTotal: 45,
    rows: [{ codigo: 'YK-001', nombre: 'Filtro', precio: '1.234' }],
  });
  const pagination = inferPaginationFromCalls([{
    method: 'GET',
    url: 'https://www.yokomitsuparts.com.uy/v2/api/catalogo?page=2&limit=20',
    responseShape: shape,
  }]);
  const fields = inferYokomitsuFieldsAvailable(extractYokomitsuProductsFromJson({
    rows: [{ codigo: 'YK-001', nombre: 'Filtro', precio: '1.234', stock: 0 }],
  }));

  assert.deepEqual(pagination.observedParams, ['limit', 'page']);
  assert.ok(pagination.observedFields.includes('recordsTotal'));
  assert.equal(fields.productName, true);
  assert.equal(fields.price, true);
  assert.equal(fields.stock, true);
  assert.equal(isLikelyYokomitsuCatalogUrl('https://www.yokomitsuparts.com.uy/v2/api/catalogo?page=1'), true);
  assert.equal(isLikelyYokomitsuCatalogUrl('https://example.com/v2/api/catalogo?page=1'), false);
});

test('Yokomitsu distingue CAPTCHA visible de scripts no visibles', () => {
  assert.equal(hasVisibleYokomitsuCaptchaChallenge([{
    tagName: 'iframe',
    title: 'reCAPTCHA',
    src: 'https://www.google.com/recaptcha/api2/anchor',
    visible: true,
  }]), true);

  assert.equal(hasVisibleYokomitsuCaptchaChallenge([{
    tagName: 'script',
    src: 'https://www.google.com/recaptcha/api.js',
    visible: false,
  }, {
    tagName: 'iframe',
    title: 'reCAPTCHA',
    src: 'https://www.google.com/recaptcha/api2/anchor',
    visible: false,
  }]), false);
});

test('Yokomitsu detecta ingreso manual exitoso sin leer credenciales', () => {
  assert.equal(hasReachedYokomitsuPortal({
    currentUrl: 'https://www.yokomitsuparts.com.uy/v2/catalogo',
    hasPasswordInput: false,
    portalElementCount: 1,
    authenticatedCatalogResponses: 0,
  }), true);

  assert.equal(hasReachedYokomitsuPortal({
    currentUrl: 'https://www.yokomitsuparts.com.uy/v2/login',
    hasPasswordInput: true,
    portalElementCount: 0,
    authenticatedCatalogResponses: 0,
  }), false);
});

test('Yokomitsu usa /v2/home canonico como entrada principal', () => {
  assert.equal(YOKOMITSU_LOGIN_URL, 'https://www.yokomitsuparts.com.uy/v2/home');
  assert.equal(YOKOMITSU_LEGACY_LOGIN_URL, 'https://yokomitsuparts.com.uy/v2/login');
  assert.notEqual(YOKOMITSU_LOGIN_URL, YOKOMITSU_LEGACY_LOGIN_URL);
});

test('Yokomitsu no asume autenticacion por estar en /v2/home si hay password', () => {
  assert.equal(hasReachedYokomitsuPortal({
    currentUrl: 'https://www.yokomitsuparts.com.uy/v2/home',
    hasPasswordInput: true,
    portalElementCount: 4,
    authenticatedCatalogResponses: 1,
    hasYokomitsuFrontCookie: true,
  }), false);
});

test('Yokomitsu acepta /v2/home autenticado por senales de portal o cookie', () => {
  assert.equal(hasReachedYokomitsuPortal({
    currentUrl: 'https://www.yokomitsuparts.com.uy/v2/home',
    hasPasswordInput: false,
    portalElementCount: 1,
    authenticatedCatalogResponses: 0,
  }), true);

  assert.equal(hasReachedYokomitsuPortal({
    currentUrl: 'https://www.yokomitsuparts.com.uy/v2/home',
    hasPasswordInput: false,
    portalElementCount: 0,
    authenticatedCatalogResponses: 0,
    hasYokomitsuFrontCookie: true,
  }), true);
});

test('Yokomitsu detecta timeout esperando login manual', () => {
  assert.equal(hasYokomitsuManualLoginTimedOut(1_000, 300_999, 300_000), false);
  assert.equal(hasYokomitsuManualLoginTimedOut(1_000, 301_000, 300_000), true);
});

test('Yokomitsu limita la muestra a cinco productos', () => {
  const products = extractYokomitsuProductsFromJson({
    data: Array.from({ length: 8 }, (_, index) => ({
      codigo: `YK-${index + 1}`,
      nombre: `Filtro ${index + 1}`,
      precio: '1.234',
    })),
  });

  assert.equal(products.length, 5);
  assert.equal(products[0].sku, 'YK-1');
  assert.equal(products[4].sku, 'YK-5');
});

test('Yokomitsu limita a cinco productos desde data HTML', () => {
  const data = Array.from({ length: 7 }, (_, index) => `
    <article class="producto" data-codprod="YK-${index + 1}">
      <a href="/v2/producto-detalle/demo/${index + 1}/pieza-${index + 1}"><h3>Pieza ${index + 1}</h3></a>
      <span>Cód. Yokomitsu: YK-${index + 1}</span>
      <strong class="precio">$1.234 +IVA</strong>
    </article>
  `).join('');
  const products = extractYokomitsuProductsFromJson({ number_register: 7, data });

  assert.equal(products.length, 5);
  assert.equal(products[0].sku, 'YK-1');
  assert.equal(products[4].sku, 'YK-5');
});

test('Yokomitsu cierra el contexto incluso si clearCookies falla', async () => {
  const calls: string[] = [];
  await assert.rejects(() => closeYokomitsuSessionResources({
    context: {
      clearCookies: async () => {
        calls.push('clearCookies');
        throw new Error('clear failed');
      },
      close: async () => {
        calls.push('context.close');
      },
    },
    browser: {
      close: async () => {
        calls.push('browser.close');
      },
    },
  }), /clear failed/);

  assert.deepEqual(calls, ['clearCookies', 'context.close', 'browser.close']);
});

function readYokomitsuFixture(name: string): string {
  return readFileSync(join(process.cwd(), 'src', 'scraping', 'domain', 'fixtures', 'yokomitsu', name), 'utf8');
}
