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

test('preserva productos sin precio en la extraccion del servicio', async () => {
  const savedCatalogs: Array<{ site: string; products: Array<{ productName?: string; price?: string; qualityWarnings?: string[] }> }> = [];
  const inventoryUpserts: Array<Array<{ productName?: string; price?: string }>> = [];

  const service = new CatalogScrapingService(
    {
      async runTask(task: string) {
        if (task === 'crawl') {
          return {
            provider: 'http',
            requestedAt: '2026-06-06T00:00:00.000Z',
            raw: { discoveredUrls: ['https://example.com/producto/1'] },
            normalizedProducts: [],
          };
        }

        return {
          provider: 'http',
          requestedAt: '2026-06-06T00:00:01.000Z',
          raw: {
            products: [
              {
                name: 'Producto sin precio',
                productUrl: 'https://example.com/producto/1',
                brand: 'Marca',
              },
            ],
          },
          normalizedProducts: [],
        };
      },
    } as never,
    {
      async getBySite() {
        return [];
      },
      async getAll() {
        return [];
      },
      async upsertSiteProducts(_site: string, products: Array<{ productName?: string; price?: string }>) {
        inventoryUpserts.push(products);
        return { created: products.length, updated: 0, totalForSite: products.length };
      },
      async countAll() {
        return 1;
      },
      async countBySite() {
        return 1;
      },
    } as never,
    {
      async saveSiteCatalog(site: string, products: Array<{ productName?: string; price?: string; qualityWarnings?: string[] }>) {
        savedCatalogs.push({ site, products });
        return { outputPath: '', total: products.length, imagesSaved: 0, products };
      },
    } as never,
    {
      async ensureCatalogTables() {},
      async query() {
        return { rows: [] };
      },
    } as never,
  );

  const run = await service.scrapeCatalogWithPrices({
    urls: ['https://example.com'],
    maxPagesPerSite: 10,
    maxProductsPerSite: 10,
    siteConcurrency: 1,
  });

  assert.equal(run.inventorySize, 1);
  assert.equal(savedCatalogs.length, 1);
  assert.equal(savedCatalogs[0]?.site, 'https://example.com');
  assert.equal(savedCatalogs[0]?.products[0]?.productName, 'Producto sin precio');
  assert.equal(savedCatalogs[0]?.products[0]?.price, undefined);
  assert.ok(savedCatalogs[0]?.products[0]?.qualityWarnings?.includes('missing_price'));
  assert.equal(inventoryUpserts.length, 1);
  assert.equal(inventoryUpserts[0]?.[0]?.productName, 'Producto sin precio');
});

test('no recorta las urls descubiertas por maxProductsPerSite', async () => {
  let extractPayloadUrls: string[] = [];

  const service = new CatalogScrapingService(
    {
      async runTask(task: string, payload: { urls?: string[] }) {
        if (task === 'crawl') {
          return {
            provider: 'http',
            requestedAt: '2026-06-06T00:00:00.000Z',
            raw: {
              discoveredUrls: [
                'https://example.com/producto/1',
                'https://example.com/producto/2',
                'https://example.com/producto/3',
              ],
            },
            normalizedProducts: [],
          };
        }

        extractPayloadUrls = payload.urls ?? [];

        return {
          provider: 'http',
          requestedAt: '2026-06-06T00:00:01.000Z',
          raw: { products: [] },
          normalizedProducts: [],
        };
      },
    } as never,
    {
      async getBySite() {
        return [];
      },
      async getAll() {
        return [];
      },
      async upsertSiteProducts() {
        return { created: 0, updated: 0, totalForSite: 0 };
      },
      async countAll() {
        return 0;
      },
      async countBySite() {
        return 0;
      },
    } as never,
    {
      async saveSiteCatalog(site: string, products: Array<{ productName?: string; price?: string; qualityWarnings?: string[] }>) {
        return { outputPath: '', total: products.length, imagesSaved: 0, products };
      },
    } as never,
    {
      async ensureCatalogTables() {},
      async query() {
        return { rows: [] };
      },
    } as never,
  );

  await service.scrapeCatalogWithPrices({
    urls: ['https://example.com'],
    maxPagesPerSite: 10,
    maxProductsPerSite: 1,
    siteConcurrency: 1,
  });

  assert.deepEqual(extractPayloadUrls, [
    'https://example.com/producto/1',
    'https://example.com/producto/2',
    'https://example.com/producto/3',
  ]);
});

test('expone stats globales y por sitio', async () => {
  const service = new CatalogScrapingService(
    { runTask: async () => ({}) } as never,
    {
      async getBySite() {
        return [];
      },
      async getAll() {
        return [];
      },
      async upsertSiteProducts() {
        return { created: 0, updated: 0, totalForSite: 0 };
      },
      async countAll() {
        return 42;
      },
      async countBySite() {
        return 0;
      },
      async getStats() {
        return {
          total: 42,
          bySite: [
            { site: 'https://www.chaparei.com/productos/?m=171', total: 18 },
            { site: 'https://www.selvir.com.uy/product-category/carroceria/', total: 24 },
          ],
        };
      },
    } as never,
    { saveSiteCatalog: async () => ({ outputPath: '', total: 0, imagesSaved: 0, products: [] }) } as never,
    { ensureCatalogTables: async () => {}, query: async () => ({ rows: [] }) } as never,
  );

  const stats = await service.getStats();

  assert.deepEqual(stats, {
    total: 42,
    bySite: [
      { site: 'https://www.chaparei.com/productos/?m=171', total: 18 },
      { site: 'https://www.selvir.com.uy/product-category/carroceria/', total: 24 },
    ],
  });
});
