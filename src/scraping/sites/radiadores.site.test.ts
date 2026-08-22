import assert from 'node:assert/strict';
import test from 'node:test';
import { findDomainRule, isAdmittedHouseUrl } from '../domain/domain-rules';
import { DEFAULT_CATALOG_SITES, NEW_CATALOG_SITES } from '../dto/catalog-request.dto';
import { getCatalogSite } from './catalog-sites';

test('registra Diego Radiadores como WooCommerce habilitado', () => {
  const site = getCatalogSite('diegoradiadores');

  assert.ok(site);
  assert.equal(site.enabled, true);
  assert.equal(site.platform, 'woocommerce');
  assert.deepEqual(site.seedUrls, ['https://diegoradiadores.com.uy/tienda/']);
  assert.equal(site.productUrlPatterns.some((pattern) => pattern.test('https://diegoradiadores.com.uy/producto/radiador-demo/')), true);
  assert.equal(isAdmittedHouseUrl('https://diegoradiadores.com.uy/tienda/'), true);
});

test('registra Leo Radiadores como Shopify habilitado', () => {
  const site = getCatalogSite('leoradiadores');

  assert.ok(site);
  assert.equal(site.enabled, true);
  assert.equal(site.platform, 'shopify');
  assert.deepEqual(site.seedUrls, ['https://www.leoradiadores.com.uy/collections/all']);
  assert.equal(site.productUrlPatterns.some((pattern) => pattern.test('https://www.leoradiadores.com.uy/products/radiador-demo')), true);
  assert.equal(isAdmittedHouseUrl('https://www.leoradiadores.com.uy/collections/all?page=135'), true);
});

test('incluye las casas de radiadores en el refresh por defecto', () => {
  assert.equal(NEW_CATALOG_SITES.includes('https://diegoradiadores.com.uy/tienda/'), true);
  assert.equal(NEW_CATALOG_SITES.includes('https://www.leoradiadores.com.uy/collections/all'), true);
  assert.equal(DEFAULT_CATALOG_SITES.includes('https://diegoradiadores.com.uy/tienda/'), true);
  assert.equal(DEFAULT_CATALOG_SITES.includes('https://www.leoradiadores.com.uy/collections/all'), true);
});

test('define reglas de dominio para Diego y Leo Radiadores', () => {
  const diego = findDomainRule('https://diegoradiadores.com.uy/tienda/');
  const leo = findDomainRule('https://www.leoradiadores.com.uy/collections/all');

  assert.equal(diego?.id, 'diegoradiadores');
  assert.equal(leo?.id, 'leoradiadores');
  assert.equal(leo?.productUrlPatterns.some((pattern) => pattern.test('https://www.leoradiadores.com.uy/products/radiador-demo')), true);
});
