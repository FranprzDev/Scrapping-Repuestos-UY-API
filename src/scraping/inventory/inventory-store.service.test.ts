import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { InventoryStoreService } from './inventory-store.service';

test('getStats agrupa por host base y no por url completa', async () => {
  const queries: string[] = [];

  const service = new InventoryStoreService({
    async query(sql: string) {
      queries.push(sql);

      if (/SELECT COUNT\(\*\)::text AS total FROM scraping_inventory$/i.test(sql.trim())) {
        return { rows: [{ total: '5' }] } as never;
      }

      return {
        rows: [
          { site: 'www.chaparei.com', total: '3' },
          { site: 'www.selvir.com.uy', total: '2' },
        ],
      } as never;
    },
  } as never);

  const stats = await service.getStats();

  assert.equal(stats.total, 5);
  assert.deepEqual(stats.bySite, [
    { site: 'www.chaparei.com', total: 3 },
    { site: 'www.selvir.com.uy', total: 2 },
  ]);
  assert.ok(queries.some((sql) => sql.includes('split_part')));
  assert.ok(queries.some((sql) => sql.includes("replace(replace(lower(site), 'https://', ''), 'http://', '')")));
});
