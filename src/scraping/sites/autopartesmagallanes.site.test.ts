import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalogSite } from './catalog-sites';

test('Autopartes Magallanes enables its WooCommerce vehicle archive', () => {
  const site = getCatalogSite('autopartesmagallanes');
  assert.ok(site);
  assert.equal(site.enabled, true);
  assert.equal(site.platform, 'woocommerce');
  assert.equal(site.seedUrls[0], 'https://autopartesmagallanes.uy/products/');
  assert.ok(site.productUrlPatterns.some((rule) => rule.test(
    'https://autopartesmagallanes.uy/para-desarmar/repuestos-de/repuestos-de-fiat-uno-2014-ref-ch562/',
  )));
  assert.ok(site.productUrlPatterns.some((rule) => rule.test(
    'https://autopartesmagallanes.uy/interiores-molduras-e-iluminacion-exterior/plasticos-y-molduras/plasticos-y-molduras-suzuki-swift-1-2-gl-2018-ref-11367-q3a8/',
  )));
});
