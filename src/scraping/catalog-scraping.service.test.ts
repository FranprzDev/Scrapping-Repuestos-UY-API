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
              summary: { results: [{ site: 'https://taxitor.uy/articulos/mostrar/1319', status: 'success' }] },
            },
          ],
        } as never;
      }

      if (/FROM\s+scraping_run_sites[\s\S]*WHERE run_id = \$1::uuid/i.test(sql)) {
        return {
          rows: [
            {
              site: 'https://taxitor.uy/articulos/mostrar/1319',
              status: 'success',
              payload: {
                site: 'https://taxitor.uy/articulos/mostrar/1319',
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
  assert.equal(run?.sites[0]?.site, 'https://taxitor.uy/articulos/mostrar/1319');
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
            raw: { discoveredUrls: ['https://taxitor.uy/articulos/mostrar/1319'] },
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
                productUrl: 'https://taxitor.uy/articulos/mostrar/1319',
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
    urls: ['https://taxitor.uy/articulos/mostrar/1319'],
    maxPagesPerSite: 10,
    maxProductsPerSite: 10,
    siteConcurrency: 1,
  });

  assert.equal(run.inventorySize, 1);
  assert.equal(savedCatalogs.length, 1);
  assert.equal(savedCatalogs[0]?.site, 'https://taxitor.uy/articulos/mostrar/1319');
  assert.equal(savedCatalogs[0]?.products[0]?.productName, 'Producto sin precio');
  assert.equal(savedCatalogs[0]?.products[0]?.price, undefined);
  assert.ok(savedCatalogs[0]?.products[0]?.qualityWarnings?.includes('missing_price'));
  assert.equal(inventoryUpserts.length, 1);
  assert.equal(inventoryUpserts[0]?.[0]?.productName, 'Producto sin precio');
});

test('Taxitor refresca discovery aunque ya existan links cacheados', async () => {
  let crawlCalls = 0;

  const service = new CatalogScrapingService(
    {
      async runTask(task: string, payload: { urls?: string[]; url?: string }) {
        if (task === 'crawl') {
          crawlCalls += 1;
          return {
            provider: 'http',
            requestedAt: '2026-06-06T00:00:00.000Z',
            raw: {
              discoveredUrls: ['https://taxitor.uy/articulos/mostrar/1319'],
            },
            normalizedProducts: [],
          };
        }

        return {
          provider: 'http',
          requestedAt: '2026-06-06T00:00:01.000Z',
          raw: {
            products: [
              {
                name: 'Producto Taxitor',
                productUrl: 'https://taxitor.uy/articulos/mostrar/1319',
                price: '100',
              },
            ],
          },
          normalizedProducts: [],
        };
      },
    } as never,
    {
      async getBySite() {
        return [
          {
            site: 'https://taxitor.uy/articulos/filtro/1/-/-/',
            url: 'https://taxitor.uy/articulos/mostrar/1319',
            source: 'crawl',
            firstSeenAt: '2026-06-06T00:00:00.000Z',
            lastSeenAt: '2026-06-06T00:00:00.000Z',
            hitCount: 1,
          },
        ];
      },
      async getAll() {
        return [];
      },
      async upsertSiteProducts() {
        return { created: 0, updated: 0, totalForSite: 1 };
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
    urls: ['https://taxitor.uy/articulos/filtro/1/-/-/'],
    maxPagesPerSite: 10,
    maxProductsPerSite: 10,
    siteConcurrency: 1,
  });

  assert.equal(crawlCalls, 1);
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
                'https://taxitor.uy/articulos/mostrar/1319',
                'https://taxitor.uy/articulos/mostrar/1320',
                'https://taxitor.uy/articulos/mostrar/1321',
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
    urls: ['https://taxitor.uy/articulos/mostrar/1319'],
    maxPagesPerSite: 10,
    maxProductsPerSite: 1,
    siteConcurrency: 1,
  });

  assert.deepEqual(extractPayloadUrls, [
    'https://taxitor.uy/articulos/mostrar/1319',
    'https://taxitor.uy/articulos/mostrar/1320',
    'https://taxitor.uy/articulos/mostrar/1321',
  ]);
});

test('eleva el limite de productos por sitio para Selvir', async () => {
  let extractMaxItems: number | undefined;

  const service = new CatalogScrapingService(
    {
      async runTask(task: string, payload: { maxItems?: number }) {
        if (task === 'crawl') {
          return {
            provider: 'http',
            requestedAt: '2026-06-06T00:00:00.000Z',
            raw: { discoveredUrls: ['https://www.selvir.com.uy/product-category/carroceria/'] },
            normalizedProducts: [],
          };
        }

        extractMaxItems = payload.maxItems;

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
    urls: ['https://www.selvir.com.uy/product-category/carroceria/'],
    siteConcurrency: 1,
  });

  assert.equal(extractMaxItems, 100000);
});

test('filtra urls externas y casas no admitidas antes de extraer', async () => {
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
                'https://www.mundopirotecnico.uy/catalogo/tortas-y-festivales/linea-tradicional/torta-rocky-41-tiros-nuevo-2023-mp1006/',
                'https://api.whatsapp.com/send?text=Hola',
                'https://taxitor.uy/articulos/mostrar/1319',
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
    urls: ['https://taxitor.uy/articulos/mostrar/1319'],
    maxPagesPerSite: 10,
    maxProductsPerSite: 1,
    siteConcurrency: 1,
  });

  assert.deepEqual(extractPayloadUrls, ['https://taxitor.uy/articulos/mostrar/1319']);
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

test('pagina inventario con 200 items y calcula hasMore con el total', async () => {
  let pagination: { limit?: number; offset?: number } | undefined;

  const service = new CatalogScrapingService(
    { runTask: async () => ({}) } as never,
    {
      async getFilteredPage(_filters: never, currentPagination: { limit?: number; offset?: number }) {
        pagination = currentPagination;
        return Array.from({ length: 200 }, (_, index) => ({
          id: `id-${index}`,
          site: 'https://taxitor.uy/articulos/mostrar/1319',
          productName: `Producto ${index}`,
          price: '100',
          extractedAt: '2026-06-06T00:00:00.000Z',
          provider: 'domain' as const,
          createdAt: '2026-06-06T00:00:00.000Z',
          updatedAt: '2026-06-06T00:00:00.000Z',
          lastSeenAt: '2026-06-06T00:00:00.000Z',
        }));
      },
      async countFiltered() {
        return 250;
      },
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
    { saveSiteCatalog: async () => ({ outputPath: '', total: 0, imagesSaved: 0, products: [] }) } as never,
    { ensureCatalogTables: async () => {}, query: async () => ({ rows: [] }) } as never,
  );

  const page = await service.getCurrentInventory({ site: 'taxitor.uy' }, { limit: 200, offset: 0 });

  assert.deepEqual(pagination, { limit: 200, offset: 0 });
  assert.equal(page.products.length, 200);
  assert.equal(page.hasMore, true);
  assert.equal(page.total, 250);
});

test('resetea por completo los datos scrapeados y limpia el archive', async () => {
  const queries: string[] = [];
  let archiveCleared = false;

  const service = new CatalogScrapingService(
    { runTask: async () => ({}) } as never,
    {
      async getFilteredPage() {
        return [];
      },
      async countFiltered() {
        return 0;
      },
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
    { saveSiteCatalog: async () => ({ outputPath: '', total: 0, imagesSaved: 0, products: [] }), clearAll: async () => { archiveCleared = true; } } as never,
    {
      async ensureCatalogTables() {},
      async query(sql: string) {
        queries.push(sql.trim());
        if (/DELETE FROM scraping_inventory/i.test(sql)) {
          return { rows: [{ id: '1' }, { id: '2' }] } as never;
        }

        if (/DELETE FROM scraping_site_links/i.test(sql)) {
          return { rows: [{ url: 'a' }] } as never;
        }

        if (/DELETE FROM scraping_run_sites/i.test(sql)) {
          return { rows: [{ site: 'a' }, { site: 'b' }, { site: 'c' }] } as never;
        }

        if (/DELETE FROM scraping_runs/i.test(sql)) {
          return { rows: [{ id: 'run-1' }] } as never;
        }

        if (/DELETE FROM scraping_jobs/i.test(sql)) {
          return { rows: [{ id: 'job-1' }, { id: 'job-2' }] } as never;
        }

        return { rows: [] } as never;
      },
    } as never,
  );

  const result = await service.resetCatalogData();

  assert.equal(result.inventoryDeleted, 2);
  assert.equal(result.siteLinksDeleted, 1);
  assert.equal(result.runSitesDeleted, 3);
  assert.equal(result.runsDeleted, 1);
  assert.equal(result.jobsDeleted, 2);
  assert.equal(archiveCleared, true);
  assert.ok(queries.some((sql) => /BEGIN/i.test(sql)));
  assert.ok(queries.some((sql) => /COMMIT/i.test(sql)));
});
