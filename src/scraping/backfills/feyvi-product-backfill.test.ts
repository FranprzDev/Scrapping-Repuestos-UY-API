import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProductRecord } from '../interfaces/scraping.types';
import { PostgresFeyviProductBackfillStore } from './feyvi-product-backfill-postgres';
import { FeyviBackfillRow, FeyviBackfillStore, runFeyviProductBackfill } from './feyvi-product-backfill';

const sourceUrl = 'https://www.feyvi.com.uy/repuestos/acabamiento-interior/consola-de-techo/cubierta-interior-espejo-retrovisor/';
const fixtureHtml = readFileSync(join(process.cwd(), 'src', 'scraping', 'domain', 'fixtures', 'feyvi', 'reference-detail.html'), 'utf8');

test('Feyvi product backfill package script runs the compiled production entrypoint', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.equal(packageJson.scripts['feyvi:products:backfill'], 'node dist/scraping/backfills/feyvi-product-backfill.cli.js');
});

test('Feyvi product backfill dry-run extracts fields but does not write', async () => {
  const store = new MemoryFeyviStore([{
    id: '1',
    sourceUrl,
    product: existingProduct(),
  }]);

  const summary = await runFeyviProductBackfill({
    limit: 1,
    store,
    fetchProductHtml: async () => ({ finalUrl: sourceUrl, body: fixtureHtml }),
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.totalCandidates, 1);
  assert.equal(summary.withValidImage, 1);
  assert.equal(summary.withCompatibility, 1);
  assert.equal(summary.wouldUpdate, 1);
  assert.equal(summary.updated, 0);
  assert.equal(store.updated.length, 0);
  assert.equal(summary.items[0].newImageUrl, 'https://www.feyvi.com.uy/images/thumbnails/1216/896/detailed/32/26278125g_1.jpg');
  assert.deepEqual(summary.items[0].compatibleVehicles, [
    'Chevrolet - ONIX 1.2 MPI',
    'Chevrolet - ONIX PLUS 1.2 MPI',
  ]);
});

test('Feyvi product backfill apply updates only Feyvi enrichment fields', async () => {
  const store = new MemoryFeyviStore([{
    id: '1',
    sourceUrl,
    product: existingProduct(),
  }]);

  await runFeyviProductBackfill({
    apply: true,
    store,
    fetchProductHtml: async () => ({ finalUrl: sourceUrl, body: fixtureHtml }),
  });

  assert.equal(store.updated.length, 1);
  const updated = store.updated[0].product;
  assert.equal(updated.price, '71');
  assert.equal(updated.sku, '26278125GMC');
  assert.equal(updated.sourceUrl, sourceUrl);
  assert.equal(updated.brand, 'General Motors');
  assert.equal(updated.imageUrl, 'https://www.feyvi.com.uy/images/thumbnails/1216/896/detailed/32/26278125g_1.jpg');
  assert.ok(updated.imageUrls?.includes('https://www.feyvi.com.uy/images/detailed/32/26278125g_1.jpg'));
  assert.deepEqual(updated.compatibleBrands, ['Chevrolet']);
  assert.deepEqual(updated.compatibleModels, ['ONIX 1.2 MPI', 'ONIX PLUS 1.2 MPI']);
  assert.deepEqual(updated.compatibleVehicles, ['Chevrolet - ONIX 1.2 MPI', 'Chevrolet - ONIX PLUS 1.2 MPI']);
  assert.equal(updated.compatibleVersions, undefined);
});

test('Postgres Feyvi product backfill store selects Feyvi detail URLs and updates only requested JSON keys', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const postgres = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ id: '1', source_url: sourceUrl, product: existingProduct() }] };
    },
  };
  const store = new PostgresFeyviProductBackfillStore(postgres as any);

  const rows = await store.findCandidates(5);
  await store.updateProductFields('1', {
    ...existingProduct(),
    brand: 'General Motors',
    imageUrl: 'https://www.feyvi.com.uy/images/detailed/32/26278125g_1.jpg',
    imageUrls: ['https://www.feyvi.com.uy/images/detailed/32/26278125g_1.jpg'],
    compatibleBrands: ['Chevrolet'],
    compatibleModels: ['ONIX 1.2 MPI'],
    compatibleVehicles: ['Chevrolet - ONIX 1.2 MPI'],
  }, existingProduct(), 'unit-test');

  assert.equal(rows.length, 1);
  assert.match(calls[0].sql, /feyvi\\\.com\\\.uy\/repuestos/);
  assert.match(calls[0].sql, /LIMIT \$1/);
  assert.deepEqual(calls[0].params, [5, null]);
  assert.match(calls[1].sql, /feyvi_apply_patch/);
  assert.match(calls[1].params[2] as string, /compatibleVehicles/);
  assert.equal(JSON.parse(calls[1].params[2] as string).imageUrl, 'https://www.feyvi.com.uy/images/detailed/32/26278125g_1.jpg');
  assert.deepEqual(JSON.parse(calls[1].params[2] as string).compatibleVehicles, ['Chevrolet - ONIX 1.2 MPI']);
});

class MemoryFeyviStore implements FeyviBackfillStore {
  readonly updated: Array<{ id: string; product: ProductRecord }> = [];

  constructor(private readonly rows: FeyviBackfillRow[]) {}

  async findCandidates(limit?: number, afterId?: string): Promise<FeyviBackfillRow[]> {
    const rows = this.rows.filter((row) => !afterId || row.id > afterId);
    return typeof limit === 'number' ? rows.slice(0, limit) : rows;
  }

  async updateProductFields(id: string, product: ProductRecord): Promise<void> {
    this.updated.push({ id, product });
  }
}

function existingProduct(): ProductRecord {
  return {
    productName: 'APLIQUE CUBIERTA INTERIOR ESPEJO RETROVISOR',
    price: '999',
    currency: 'UYU',
    sku: '26278125GMC',
    sourceUrl,
    imageUrl: 'https://www.feyvi.com.uy/images/logos/29/Logo-Web.png',
    extractedAt: new Date('2026-08-22T00:00:00.000Z').toISOString(),
    provider: 'domain',
  };
}

test('Feyvi rejects HTTP errors, unexpected redirects and incomplete pages without writes', async () => {
  for (const response of [
    { finalUrl: sourceUrl, body: fixtureHtml, statusCode: 403 },
    { finalUrl: 'https://www.feyvi.com.uy/', body: fixtureHtml, statusCode: 200 },
    { finalUrl: sourceUrl, body: '<h1>Access denied</h1>', statusCode: 200 },
  ]) {
    const store = new MemoryFeyviStore([{ id: '1', sourceUrl, product: existingProduct() }]);
    const result = await runFeyviProductBackfill({ apply: true, store, fetchProductHtml: async () => response });
    assert.equal(result.errors, 1);
    assert.equal(store.updated.length, 0);
  }
});

test('Feyvi preserves a valid local photo and existing compatibility while recovering price and SKU', async () => {
  const previous = { ...existingProduct(), price: undefined, sku: undefined, imageUrl: 'https://shop.example/images/owned.jpg', compatibleModels: ['Verified legacy model'] };
  const store = new MemoryFeyviStore([{ id: '1', sourceUrl, product: previous }]);
  await runFeyviProductBackfill({ apply: true, store, fetchProductHtml: async () => ({ finalUrl: sourceUrl, body: fixtureHtml }) });
  assert.equal(store.updated[0].product.price, '71');
  assert.equal(store.updated[0].product.sku, '26278125GMC');
  assert.equal(store.updated[0].product.imageUrl, previous.imageUrl);
  assert.ok(store.updated[0].product.compatibleModels?.includes('Verified legacy model'));
});

test('Feyvi keyset batching processes each product once and bounded retry recovers HTTP 503', async () => {
  const store = new MemoryFeyviStore(['1','2','3','4','5'].map(id => ({id,sourceUrl,product:existingProduct()})));
  let attempts = 0;
  const summary = await runFeyviProductBackfill({ store, batchSize: 2, retries: 1, fetchProductHtml: async () => {
    attempts += 1;
    if (attempts === 1) return {finalUrl:sourceUrl,body:'',statusCode:503};
    return {finalUrl:sourceUrl,body:fixtureHtml,statusCode:200};
  }});
  assert.equal(summary.totalCandidates, 5);
  assert.equal(summary.errors, 0);
  assert.equal(attempts, 6);
});
