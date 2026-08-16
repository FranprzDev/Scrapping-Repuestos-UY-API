import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GenericHtmlPaginationAdapter } from './adapters';
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

test('aplica max-pages durante discovery y no despues de recorrer el catalogo', async () => {
  const adapter = new GenericHtmlPaginationAdapter();
  let requests = 0;
  const context = mockContext(new Map([
    ['https://fixture.test/list-a', '<a href="/product/a1">A1</a><a rel="next" href="/list-a?page=2">next</a>'],
    ['https://fixture.test/list-a?page=2', '<a href="/product/a2">A2</a><a rel="next" href="/list-a?page=3">next</a>'],
    ['https://fixture.test/list-a?page=3', '<a href="/product/a3">A3</a>'],
    ['https://fixture.test/list-b', '<a href="/product/b1">B1</a>'],
  ]));
  const originalFetch = context.fetch;
  context.maxPages = 2;
  context.fetch = async (...args) => {
    requests += 1;
    return originalFetch(...args);
  };

  const discovery = await adapter.discover(context);
  assert.equal(discovery.pages.length, 2);
  assert.equal(requests, 2);
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

function mockContext(htmlByUrl: Map<string, string>): CatalogRequestContext {
  return {
    site,
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
