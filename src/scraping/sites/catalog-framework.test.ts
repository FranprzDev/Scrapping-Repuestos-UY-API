import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GenericHtmlPaginationAdapter } from './adapters';
import { auditCounts } from './adapters/base.adapter';
import { parseCatalogCommandArgs } from './catalog-command-args';
import { CatalogRequestQueue } from './catalog-queue';
import { normalizeCatalogUrl } from './catalog-sites';
import { createSiteScaffold } from './site-generator';
import type { CatalogRequestContext, CatalogSiteConfig } from './types';

const site: CatalogSiteConfig = {
  id: 'fixture',
  label: 'Fixture',
  hostname: 'fixture.test',
  seedUrls: ['https://fixture.test/list-a', 'https://fixture.test/list-b'],
  platform: 'generic-html',
  authentication: { type: 'none' },
  productUrlPatterns: [/\/product\//i],
  categoryUrlPatterns: [/\/list-/i],
  paginationStrategy: { type: 'next-link', maxPages: 10 },
  priceLocale: 'es-UY',
  preserveOutOfStock: true,
  concurrency: 2,
  requestDelay: 0,
  enabled: true,
};

test('parsea --max-pages para catalog-command', () => {
  const parsed = parseCatalogCommandArgs(['--mode=audit', '--site=fixture', '--max-pages=20'], {});

  assert.equal(parsed.maxPages, 20);
});

test('parsea --max-products para catalog-command', () => {
  const parsed = parseCatalogCommandArgs(['--mode=audit', '--site=fixture', '--max-products=600'], {});

  assert.equal(parsed.maxProducts, 600);
});

test('pagina cada listado de forma independiente aunque existan URLs repetidas', async () => {
  const adapter = new GenericHtmlPaginationAdapter();
  const htmlByUrl = new Map([
    ['https://fixture.test/list-a', '<a href="/product/shared">Shared</a><a rel="next" href="/list-a?page=2">next</a>'],
    ['https://fixture.test/list-a?page=2', '<a href="/product/a2">A2</a>'],
    ['https://fixture.test/list-b', '<a href="/product/shared">Shared</a><a rel="next" href="/list-b?page=2">next</a>'],
    ['https://fixture.test/list-b?page=2', '<a href="/product/b2">B2</a>'],
  ]);
  const discovery = await adapter.discover(mockContext(htmlByUrl));

  assert.equal(discovery.pages.length, 4);
  assert.deepEqual(discovery.uniqueUrls.sort(), [
    'https://fixture.test/product/a2',
    'https://fixture.test/product/b2',
    'https://fixture.test/product/shared',
  ]);
});

test('deduplica globalmente al final de la normalizacion', () => {
  const adapter = new GenericHtmlPaginationAdapter();
  const normalized = adapter.normalize(site, [
    { productName: 'A', sourceUrl: 'https://fixture.test/product/a?utm_source=x', sku: '1', extractedAt: 'now', provider: 'domain' },
    { productName: 'A newer', sourceUrl: 'https://fixture.test/product/a', sku: '1', extractedAt: 'later', provider: 'domain' },
  ]);

  assert.equal(normalized.products.length, 1);
  assert.equal(normalized.duplicates.length, 1);
  assert.equal(normalized.products[0]?.productName, 'A newer');
});

test('detecta ultima pagina cuando no hay enlace next', async () => {
  const adapter = new GenericHtmlPaginationAdapter();
  const discovery = await adapter.discover(mockContext(new Map([
    ['https://fixture.test/list-a', '<a href="/product/a">A</a>'],
    ['https://fixture.test/list-b', '<a href="/product/b">B</a>'],
  ])));

  assert.equal(discovery.pages.every((page) => page.isLastPage), true);
  assert.equal(discovery.pages.length, 2);
});

test('corta discovery por maximo de paginas', async () => {
  const adapter = new GenericHtmlPaginationAdapter();
  const discovery = await adapter.discover(mockContext(new Map([
    ['https://fixture.test/list-a', '<a href="/product/a">A</a><a rel="next" href="/list-a?page=2">next</a>'],
    ['https://fixture.test/list-b', '<a href="/product/b">B</a>'],
  ]), { maxPages: 1 }));

  assert.equal(discovery.pagesAudited, 1);
  assert.equal(discovery.terminationReason, 'max_pages');
  assert.equal(discovery.limited, true);
});

test('corta discovery por maximo de productos', async () => {
  const adapter = new GenericHtmlPaginationAdapter();
  const discovery = await adapter.discover(mockContext(new Map([
    ['https://fixture.test/list-a', '<a href="/product/a">A</a><a href="/product/b">B</a><a href="/product/c">C</a><a rel="next" href="/list-a?page=2">next</a>'],
    ['https://fixture.test/list-a?page=2', '<a href="/product/d">D</a>'],
  ]), { maxProducts: 2 }));

  assert.equal(discovery.productsAudited, 2);
  assert.equal(discovery.uniqueUrls.length, 2);
  assert.equal(discovery.terminationReason, 'max_products');
  assert.equal(discovery.limited, true);
});

test('detecta pagina repetida durante discovery', async () => {
  const adapter = new GenericHtmlPaginationAdapter();
  const discovery = await adapter.discover(mockContext(new Map([
    ['https://fixture.test/list-a', '<a href="/product/a">A</a><a rel="next" href="/list-a">next</a>'],
  ])));

  assert.equal(discovery.pagesAudited, 1);
  assert.equal(discovery.terminationReason, 'repeated_page');
  assert.equal(discovery.limited, true);
});

test('detecta falta de productos nuevos durante discovery', async () => {
  const adapter = new GenericHtmlPaginationAdapter();
  const discovery = await adapter.discover(mockContext(new Map([
    ['https://fixture.test/list-a', '<a href="/product/a">A</a><a rel="next" href="/list-a?page=2">next</a>'],
    ['https://fixture.test/list-a?page=2', '<a href="/product/a">A repeated</a><a rel="next" href="/list-a?page=3">next</a>'],
  ])));

  assert.equal(discovery.pagesAudited, 2);
  assert.equal(discovery.terminationReason, 'no_progress');
  assert.equal(discovery.limited, true);
});

test('marca reportes limitados como parciales y sin cobertura global', async () => {
  const adapter = new GenericHtmlPaginationAdapter();
  const discovery = await adapter.discover(mockContext(new Map([
    ['https://fixture.test/list-a', '<a href="/product/a">A</a><a href="/product/b">B</a><a rel="next" href="/list-a?page=2">next</a>'],
    ['https://fixture.test/list-a?page=2', '<a href="/product/c">C</a>'],
  ]), { maxProducts: 1 }));
  const report = auditCounts(
    site,
    'audit',
    discovery,
    { siteId: site.id, products: [{ productName: 'A', sourceUrl: discovery.uniqueUrls[0], extractedAt: 'now', provider: 'domain' }], rejected: [], errors: [] },
    { products: [{ productName: 'A', sourceUrl: discovery.uniqueUrls[0], extractedAt: 'now', provider: 'domain' }], duplicates: [] },
    { products: [{ productName: 'A', sourceUrl: discovery.uniqueUrls[0], extractedAt: 'now', provider: 'domain' }], rejected: [] },
  );

  assert.equal(report.limited, true);
  assert.equal(report.terminationReason, 'max_products');
  assert.deepEqual(report.requestedLimits, { maxProducts: 1 });
  assert.equal(report.productsAudited, 1);
  assert.equal(report.pagesAudited, 1);
  assert.equal(report.estimatedCoverage, null);
});

test('respeta concurrencia por dominio', async () => {
  let active = 0;
  let maxActive = 0;
  const queue = new CatalogRequestQueue({ globalConcurrency: 10, perDomainConcurrency: 2 });
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    key: String(index),
    domain: 'fixture.test',
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active -= 1;
      return index;
    },
  }));

  await queue.run(tasks);
  assert.equal(maxActive, 2);
});

test('reintenta 429 y 5xx de forma limitada', async () => {
  let attempts = 0;
  const queue = new CatalogRequestQueue({ retryAttempts: 2, retryBaseDelayMs: 1 });
  const [result] = await queue.run([{
    key: 'retry',
    domain: 'fixture.test',
    run: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('HTTP 429'), { statusCode: 429 });
      }
      return 'ok';
    },
  }]);

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('reanuda desde progreso persistente despues de un fallo', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'catalog-queue-'));
  try {
    const progressPath = path.join(tmp, 'progress.json');
    const first = new CatalogRequestQueue({ progressPath, retryAttempts: 0, globalConcurrency: 1 });
    await assert.rejects(first.run([
      { key: 'done', domain: 'fixture.test', run: async () => 'done' },
      { key: 'fail', domain: 'fixture.test', run: async () => { throw Object.assign(new Error('HTTP 500'), { statusCode: 500 }); } },
    ]));

    let doneRuns = 0;
    const second = new CatalogRequestQueue({ progressPath, retryAttempts: 0, globalConcurrency: 1 });
    await assert.rejects(second.run([
      { key: 'done', domain: 'fixture.test', run: async () => { doneRuns += 1; return 'done'; } },
      { key: 'fail', domain: 'fixture.test', run: async () => { throw Object.assign(new Error('HTTP 500'), { statusCode: 500 }); } },
    ]));
    assert.equal(doneRuns, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('normaliza URLs removiendo tracking y hash', () => {
  assert.equal(
    normalizeCatalogUrl('/product/a?utm_source=x&color=rojo#detalle', 'https://Fixture.test/list'),
    'https://fixture.test/product/a?color=rojo',
  );
});

test('site:create genera definicion, prueba, fixtures y entrada de registro', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'catalog-site-'));
  try {
    const files = await createSiteScaffold({ id: 'nuevo-sitio', platform: 'generic-html', rootDir: tmp });
    assert.ok(files.some((file) => file.endsWith(path.join('definitions', 'nuevo-sitio.site.ts'))));
    assert.ok(files.some((file) => file.endsWith(path.join('fixtures', 'nuevo-sitio'))));
    const generated = await readFile(path.join(tmp, 'src', 'scraping', 'sites', 'generated-sites.ts'), 'utf8');
    assert.match(generated, /nuevoSitioSite/);
    assert.match(generated, /definitions\/nuevo-sitio\.site/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

function mockContext(htmlByUrl: Map<string, string>, limits: CatalogRequestContext['limits'] = undefined): CatalogRequestContext {
  return {
    site,
    limits,
    fetch: async (url: string) => ({
      url,
      finalUrl: url,
      statusCode: 200,
      headers: {},
      body: htmlByUrl.get(url) ?? '',
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
