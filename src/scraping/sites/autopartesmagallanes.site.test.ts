import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchHtml } from '../domain/http-client';
import { extractProductsFromHtml } from '../domain/domain-html';
import { getCatalogSite } from './catalog-sites';

test('Autopartes Magallanes keeps real product details and excludes vehicle archives', () => {
  const site = getCatalogSite('autopartesmagallanes');
  assert.ok(site);
  assert.equal(site.enabled, true);
  assert.equal(site.platform, 'woocommerce');
  assert.equal(site.seedUrls[0], 'https://autopartesmagallanes.uy/products/');

  // Archive/vehicle disassembly pages should be excluded
  const archiveUrls = [
    'https://autopartesmagallanes.uy/para-desarmar/repuestos-de/repuestos-de-fiat-uno-2014-ref-ch562/',
    'https://autopartesmagallanes.uy/para-desarmar/repuestos-de/',
    'https://autopartesmagallanes.uy/restos/repuestos-de-para-desarmar/repuestos-de-chevrolet-onix-1-2-ls-2021-refch532/',
  ];

  for (const url of archiveUrls) {
    assert.equal(
      site.productUrlPatterns.some((rule) => rule.test(url)),
      false,
      `archive URL should not be classified as product: ${url}`,
    );
    assert.ok(
      site.categoryUrlPatterns.some((rule) => rule.test(url)) || /\/repuestos-de(?:-|\/|$)/i.test(url),
      `archive URL should be classified as category: ${url}`,
    );
  }

  // Real product URLs should be included regardless of price
  const validProductUrls = [
    'https://autopartesmagallanes.uy/motor-y-electronica/bobina-de-encendido/bobina-de-encendido-chevrolet-onix-1-2-ls-2021-ref-12191-s3c1/', // with price
    'https://autopartesmagallanes.uy/ofertas/kit-de-bobinas-chevrolet-onix-1-0-1-2-ref-kit1-s3c1/', // with price
    'https://autopartesmagallanes.uy/interiores-molduras-e-iluminacion-exterior/plasticos-y-molduras/plasticos-y-molduras-suzuki-swift-1-2-gl-2018-ref-11367-q3a8/', // without price
    'https://autopartesmagallanes.uy/carroseria/manija-exterior-de-puerta-trasera-derecha/manija-exterior-de-puerta-trasera-derecha-renault-ref-11360-q3a9/', // without price
  ];

  for (const url of validProductUrls) {
    assert.equal(
      site.productUrlPatterns.some((rule) => rule.test(url)),
      true,
      `real product URL should be classified as product: ${url}`,
    );
  }
});

test('Autopartes Magallanes extracts products with and without price', async () => {
  const site = getCatalogSite('autopartesmagallanes')!;
  const rule = {
    id: 'autopartesmagallanes',
    hostnames: ['autopartesmagallanes.uy'],
    preferredMethod: 'http' as const,
    productUrlPatterns: site.productUrlPatterns,
    categoryUrlPatterns: site.categoryUrlPatterns,
    excludeUrlPatterns: [],
    positiveAvailabilityTexts: ['agregar', 'carrito'],
    negativeAvailabilityTexts: ['agotado'],
  };

  // Real product with price
  const urlWithPrice = 'https://autopartesmagallanes.uy/ofertas/kit-de-bobinas-chevrolet-onix-1-0-1-2-ref-kit1-s3c1/';
  const { body: bodyWithPrice } = await fetchHtml(urlWithPrice, 5);
  const productsWithPrice = extractProductsFromHtml(bodyWithPrice, urlWithPrice, 'domain', rule);

  assert.equal(productsWithPrice.length, 1, 'should extract exactly 1 product per URL');
  assert.ok(productsWithPrice[0].productName, 'should have product name');
  assert.ok(productsWithPrice[0].price, 'should have price for product with public pricing');
  assert.ok(productsWithPrice[0].imageUrl, 'should have image URL');

  // Real product without price
  const urlWithoutPrice = 'https://autopartesmagallanes.uy/interiores-molduras-e-iluminacion-exterior/plasticos-y-molduras/plasticos-y-molduras-suzuki-swift-1-2-gl-2018-ref-11367-q3a8/';
  const { body: bodyWithoutPrice } = await fetchHtml(urlWithoutPrice, 5);
  const productsWithoutPrice = extractProductsFromHtml(bodyWithoutPrice, urlWithoutPrice, 'domain', rule);

  assert.equal(productsWithoutPrice.length, 1, 'should extract exactly 1 product per URL (no duplicates)');
  assert.ok(productsWithoutPrice[0].productName, 'should have product name even without price');
  assert.equal(productsWithoutPrice[0].price, undefined, 'should allow undefined price');
  assert.ok(productsWithoutPrice[0].imageUrl, 'should have image URL even without price');
});
