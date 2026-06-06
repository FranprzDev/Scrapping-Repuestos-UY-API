import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CatalogScrapingService } from './catalog-scraping.service';

test('getRunById expone trace y payload de sitios', async () => {
  const postgresService = {
    async ensureCatalogTables() {},
    async query(sql: string) {
      if (/FROM\s+scraping_runs[\s\S]*WHERE id = \$1::uuid/i.test(sql)) {
        return {
          rows: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              requested_at: '2026-06-06T00:00:00.000Z',
              strategy: 'test-strategy',
              sites_processed: 1,
              inventory_size: 2,
              summary: { results: [{ site: 'https://example.com', status: 'success' }] },
            },
          ],
        } as never;
      }

      if (/FROM\s+scraping_run_sites[\s\S]*WHERE run_id = \$1::uuid/i.test(sql)) {
        return {
          rows: [
            {
              site: 'https://example.com',
              status: 'success',
              payload: {
                site: 'https://example.com',
                trace: {
                  crawl: { discoveryMethod: 'sitemap', pagesDiscovered: 3, urlsDiscovered: 10 },
                  extract: { pagesProcessed: 10, urlsRequested: 10, rawProducts: 8, mergedProducts: 7 },
                },
              },
            },
          ],
        } as never;
      }

      return { rows: [] } as never;
    },
  };

  const service = new CatalogScrapingService(
    {} as never,
    { getBySite: async () => [], getAll: async () => [], upsertSiteProducts: async () => ({ created: 0, updated: 0, totalForSite: 0 }), countAll: async () => 0, countBySite: async () => 0 } as never,
    { saveSiteCatalog: async () => ({ outputPath: '', total: 0, imagesSaved: 0, products: [] }) } as never,
    postgresService as never,
  );

  const run = await service.getRunById('11111111-1111-1111-1111-111111111111');

  assert.ok(run);
  assert.equal(run?.runId, '11111111-1111-1111-1111-111111111111');
  assert.equal(run?.sites[0]?.site, 'https://example.com');
  assert.deepEqual(run?.sites[0]?.trace, {
    crawl: { discoveryMethod: 'sitemap', pagesDiscovered: 3, urlsDiscovered: 10 },
    extract: { pagesProcessed: 10, urlsRequested: 10, rawProducts: 8, mergedProducts: 7 },
  });
  assert.equal(run?.summary.results?.length, 1);
});
