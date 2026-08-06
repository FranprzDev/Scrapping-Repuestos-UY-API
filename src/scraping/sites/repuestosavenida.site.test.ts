import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalogSite } from './catalog-sites';

test('Repuestos Avenida enables its WooCommerce shop', () => {
  const site = getCatalogSite('repuestosavenida');
  assert.ok(site);
  assert.equal(site.enabled, true);
  assert.equal(site.platform, 'woocommerce');
  assert.equal(site.seedUrls[0], 'https://repuestosavenida.com.uy/tienda/');
  assert.ok(site.productUrlPatterns.some((rule) => rule.test('https://repuestosavenida.com.uy/producto/farol-hb20/')));
});
