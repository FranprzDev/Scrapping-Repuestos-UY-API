import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalogSite } from './catalog-sites';

test('Autopartes Gil enables its WooCommerce product archive', () => {
  const site = getCatalogSite('autopartesgil');
  assert.ok(site);
  assert.equal(site.enabled, true);
  assert.equal(site.platform, 'woocommerce');
  assert.equal(site.seedUrls[0], 'https://autopartesgil.com/productos/');
  assert.ok(site.productUrlPatterns.some((rule) => rule.test('https://autopartesgil.com/producto/engranaje-chevrolet-spark-28358/')));
});
