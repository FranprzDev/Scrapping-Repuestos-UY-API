import assert from 'node:assert/strict';
import test from 'node:test';
import { GenericHtmlPaginationAdapter } from './adapters';
import { getCatalogSite } from './catalog-sites';

test('Container extracts its ASP.NET detail page without JSON-LD', async () => {
  const site = getCatalogSite('container');
  assert.ok(site);
  const adapter = new GenericHtmlPaginationAdapter();
  const result = await adapter.extract({
    site: { ...site, requestDelay: 0 },
    fetch: async (url) => ({
      url,
      finalUrl: url,
      statusCode: 200,
      headers: {},
      body: '<html><h2>BUJIA</h2><h3>BUJIA VALEO RL13HC equiv RC52LS</h3><p>Precio: $185 (impuestos incluidos)</p><p>Nº Pieza: RL13HC-RC52LS</p><button>Agregar al Carrito</button></html>',
    }),
  }, ['https://container.com.uy/Home/SearchById?filter=RL13HC-RC52LS']);

  assert.equal(result.products.length, 1);
  assert.equal(result.products[0]?.productName, 'BUJIA VALEO RL13HC equiv RC52LS');
  assert.equal(result.products[0]?.price, '185');
  assert.equal(result.products[0]?.sku, 'RL13HC-RC52LS');
});
