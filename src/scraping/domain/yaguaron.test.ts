import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalizeYaguaronProductUrl,
  dedupeYaguaronProducts,
  extractYaguaronCategoryUrls,
  extractYaguaronArticlePosition,
  extractYaguaronDeclaredTotal,
  extractYaguaronDetail,
  extractYaguaronListingSummary,
  extractYaguaronProductUrls,
  isYaguaronProductUrl,
} from './yaguaron';

const fixture = (name: string) => readFileSync(`src/scraping/domain/fixtures/yaguaron/${name}`, 'utf8');
const productUrl = 'https://www.yaguaron.com.uy/catalogo/kit-de-distribucion-tensor-y-correa-varios-modelos_123251_123251';

test('Yaguarón reconoce IDs iguales o diferentes y rechaza rutas WooCommerce', () => {
  assert.equal(isYaguaronProductUrl(productUrl), true);
  assert.equal(isYaguaronProductUrl('https://www.yaguaron.com.uy/catalogo/soporte-de-motor_111111_222222'), true);
  assert.equal(isYaguaronProductUrl('https://www.yaguaron.com.uy/producto/soporte-de-motor'), false);
  assert.equal(isYaguaronProductUrl('https://www.yaguaron.com.uy/catalogo/soporte-de-motor_111111'), false);
});

test('Yaguarón descubre categorías, productos y total declarado del listado Fenicio', () => {
  const html = fixture('listing.html');
  assert.deepEqual(extractYaguaronCategoryUrls(html, 'https://www.yaguaron.com.uy/'), [
    'https://www.yaguaron.com.uy/motor-y-componentes',
    'https://www.yaguaron.com.uy/celta/motor-y-componentes/motor',
  ]);
  assert.deepEqual(extractYaguaronListingSummary(html), { pageItems: 2, declaredTotal: 437 });
  assert.equal(extractYaguaronProductUrls(html, 'https://www.yaguaron.com.uy/').length, 2);
  assert.equal(extractYaguaronProductUrls(fixture('listing-page-2.ajax.html'), 'https://www.yaguaron.com.uy/')[0], 'https://www.yaguaron.com.uy/catalogo/soporte-de-motor_111111_222222');
});

test('Yaguarón extrae la ficha disponible y excluye imágenes ajenas al producto', () => {
  const html = fixture('detail-123251.html');
  const product = extractYaguaronDetail(`${html}<img src="/banner-home.jpg">`, `${productUrl}?utm_source=test#comprar`, 'domain');
  assert.ok(product);
  assert.equal(product.productName, 'KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS');
  assert.equal(product.sku, '123251');
  assert.equal(product.price, '1.643');
  assert.equal(product.currency, 'UYU');
  assert.equal(product.attributes?.calidad, 'ORIGINAL');
  assert.equal(product.attributes?.fabricante, 'ORIGINAL GM / AC DELCO');
  assert.equal(product.attributes?.referencias, '90531677 / 93353848');
  assert.match(product.description ?? '', /Kit original/);
  assert.equal(product.imageUrl, 'https://www.yaguaron.com.uy/imagenes/productos/123251-grande.jpg');
  assert.deepEqual(product.imageUrls, [
    'https://www.yaguaron.com.uy/imagenes/productos/123251-grande.jpg',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-detalle.jpg',
  ]);
  assert.equal(product.imageUrls?.some((url) => /logo|banner|relacionado/i.test(url)), false);
  assert.equal(product.availability, 'in_stock');
  assert.equal(product.sourceUrl, productUrl);
  assert.deepEqual(product.compatibleModels, ['Celta', 'Prisma']);
  assert.deepEqual(extractYaguaronArticlePosition(html), { current: 1, total: 437 });
  assert.equal(extractYaguaronDeclaredTotal(html), undefined);
});

test('Yaguarón conserva una ficha agotada', () => {
  const url = 'https://www.yaguaron.com.uy/catalogo/farol-trasero-izquierdo-fume-prisma-ltz_135595_135595';
  const product = extractYaguaronDetail(fixture('detail-135595.html'), url, 'domain');
  assert.equal(product?.availability, 'out_of_stock');
  assert.equal(product?.sku, '135595');
  assert.equal(product?.imageUrl, 'https://www.yaguaron.com.uy/imagenes/productos/135595.jpg');
});

test('Yaguarón canonicaliza la ficha eliminando query y fragmento', () => {
  assert.equal(canonicalizeYaguaronProductUrl(`${productUrl}/?marca=gm#detalle`), productUrl);
});

test('Yaguarón deduplica primero por URL canónica y también por Art./SKU', () => {
  const first = extractYaguaronDetail(fixture('detail-123251.html'), productUrl, 'domain');
  assert.ok(first);
  const result = dedupeYaguaronProducts([
    first,
    { ...first, sourceUrl: `${productUrl}?utm_source=duplicate` },
    { ...first, sourceUrl: 'https://www.yaguaron.com.uy/catalogo/kit-alternativo_999999_999999' },
  ]);
  assert.equal(result.products.length, 1);
  assert.equal(result.duplicates, 2);
});
