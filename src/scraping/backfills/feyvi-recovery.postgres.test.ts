import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { PostgresFeyviProductBackfillStore } from './feyvi-product-backfill-postgres';
import { runFeyviProductBackfill } from './feyvi-product-backfill';
import { PostgresService } from '../jobs/postgres.service';
import { InventoryStoreService } from '../inventory/inventory-store.service';
import type { ProductRecord } from '../interfaces/scraping.types';

test('Feyvi PostgreSQL: five-product dry-run, backed-up recovery, resume, sync preservation and rollback', {
  skip: !process.env.FEYVI_TEST_DATABASE_URL,
}, async () => {
  const connectionString = process.env.FEYVI_TEST_DATABASE_URL!;
  const destination = new URL(connectionString);
  assert.ok(['localhost', '127.0.0.1'].includes(destination.hostname), 'Only a local test database is allowed');
  assert.equal(destination.pathname, '/feyvi_validation');
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const db = { query: client.query.bind(client) } as unknown as PostgresService;
  const store = new PostgresFeyviProductBackfillStore(db);
  const fixtures = JSON.parse(readFileSync('src/scraping/domain/fixtures/feyvi/live-details.json', 'utf8')) as Array<{ url: string; file: string }>;
  const htmlByUrl = new Map(fixtures.map(f => [f.url, readFileSync(`src/scraping/domain/fixtures/feyvi/${f.file}`, 'utf8')]));
  const before: ProductRecord[] = fixtures.map((f, i) => ({
    productName: 'Historical title', price: [undefined, '0', '-10', '7', undefined][i],
    sourceUrl: f.url, provider: 'domain', extractedAt: '2026-10-01T00:00:00Z',
    imageUrl: 'https://shop.example/images/owned.jpg', imageStatus: 'completed' as any,
    compatibleModels: ['Verified legacy model'],
  }));
  await client.query('BEGIN');
  try {
    assert.equal((await client.query('SELECT count(*)::int AS count FROM scraping_inventory')).rows[0].count, 0);
    for (let i = 0; i < fixtures.length; i += 1) {
      await client.query(`INSERT INTO scraping_inventory(id,site,source_url,product,search_text)
        VALUES($1,'https://www.feyvi.com.uy/',$2,$3::jsonb,'historical')`, [`feyvi-test-${i}`, fixtures[i].url, JSON.stringify(before[i])]);
    }
    await client.query("INSERT INTO scraping_inventory_vehicle_brands(inventory_id,brand_id,confidence,evidence) VALUES('feyvi-test-0','ford','explicit','Historical verified relationship')");
    const fetchProductHtml = async (url: string) => ({ finalUrl: url, body: htmlByUrl.get(url)!, statusCode: 200 });
    const dry = await runFeyviProductBackfill({ store, fetchProductHtml, batchSize: 2 });
    assert.equal(dry.wouldUpdate, 5);
    assert.equal(dry.updated, 0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM feyvi_recovery_backups')).rows[0].count, 0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM feyvi_recovery_results')).rows[0].count, 0);
    const applied = await runFeyviProductBackfill({ store, fetchProductHtml, batchSize: 2, apply: true, runId: 'integration-five' });
    assert.equal(applied.errors, 0);
    assert.equal(applied.updated, 5);
    const rows = (await client.query('SELECT id,product,search_text FROM scraping_inventory ORDER BY id')).rows;
    assert.deepEqual(rows.map(r => r.product.price), ['681','71','7,263','194','94']);
    assert.equal(rows[0].product.sku, '55565098GMC');
    for (const row of rows) {
      assert.equal(row.product.imageUrl, before[0].imageUrl);
      assert.ok(row.product.compatibleModels.includes('Verified legacy model'));
      assert.ok(row.search_text.includes(row.product.sku.toLowerCase().replace(/([a-z])\1+/g, '$1')));
    }
    const inventory = new InventoryStoreService(db);
    const apiRows = await inventory.getFilteredPage({ site: 'feyvi.com.uy' }, { limit: 5 });
    assert.equal(apiRows.find(p => p.sku === '55565098GMC')?.price, 681);
    const resumed = await runFeyviProductBackfill({ store, fetchProductHtml, apply: true, runId: 'integration-five' });
    assert.equal(resumed.totalCandidates, 0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM feyvi_recovery_backups')).rows[0].count, 5);
    const merged = (await client.query(`SELECT feyvi_merge_product($1::jsonb,$2::jsonb) AS product`,
      [JSON.stringify(rows[0].product), JSON.stringify({price:'0',sku:'',imageUrl:'https://supplier.example/new.jpg',compatibleModels:[]})])).rows[0].product;
    assert.equal(merged.price, '681');
    assert.equal(merged.sku, '55565098GMC');
    assert.equal(merged.imageUrl, before[0].imageUrl);
    assert.ok(merged.compatibleModels.includes('Verified legacy model'));
    await client.query('SAVEPOINT future_sync');
    await inventory.upsertSiteProducts('https://www.feyvi.com.uy/', [{
      sourceUrl: fixtures[0].url, productName: rows[0].product.productName,
      price: '0', compatibleModels: [], imageUrl: 'https://www.feyvi.com.uy/images/detailed/99/new.jpg',
      extractedAt: '2026-10-11T00:00:00Z', provider: 'domain',
    }], '2026-10-11T00:00:00Z');
    const synced = (await client.query("SELECT product FROM scraping_inventory WHERE id='feyvi-test-0'")).rows[0].product;
    assert.equal(synced.price, '681');
    assert.equal(synced.sku, '55565098GMC');
    assert.equal(synced.imageUrl, before[0].imageUrl);
    assert.ok(synced.compatibleModels.includes('Verified legacy model'));
    assert.equal((await client.query("SELECT count(*)::int AS count FROM scraping_inventory_vehicle_brands WHERE inventory_id='feyvi-test-0' AND brand_id='ford'")).rows[0].count, 1);
    await client.query('ROLLBACK TO SAVEPOINT future_sync');
    await client.query('SAVEPOINT stale_write');
    await assert.rejects(store.updateProductFields('feyvi-test-0', rows[0].product, before[0], 'stale-attempt'), /concurrent_product_change/);
    await client.query('ROLLBACK TO SAVEPOINT stale_write');
    assert.equal((await client.query("SELECT feyvi_restore_run('integration-five') AS restored")).rows[0].restored, 5);
    const restored = (await client.query('SELECT product,search_text FROM scraping_inventory ORDER BY id')).rows;
    assert.deepEqual(restored.map(r => r.product), before.map(p => JSON.parse(JSON.stringify(p))));
    assert.ok(restored.every(r => r.search_text === 'historical'));
    assert.equal((await client.query("SELECT count(*)::int AS count FROM scraping_inventory_vehicle_brands WHERE inventory_id='feyvi-test-0'")).rows[0].count, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
