import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalizeItalurUrl,
  dedupeItalurProducts,
  extractItalurCategoryUrls,
  extractItalurDetail,
  extractItalurListingSummary,
  extractItalurListProducts,
  extractItalurProductUrls,
  isItalurListingUrl,
  isItalurProductUrl,
  normalizeItalurPrice,
} from './italur';

const fixture = (name: string) => readFileSync(`src/scraping/domain/fixtures/italur/${name}`, 'utf8');
const shopUrl = 'https://www.italur.com/tienda/';
const retendorUrl = 'https://www.italur.com/producto/retenedor';

test('Italur identifica y canonicaliza rutas reales', () => {
  assert.equal(isItalurProductUrl(retendorUrl), true);
  assert.equal(isItalurListingUrl(shopUrl), true);
  assert.equal(isItalurListingUrl('https://www.italur.com/categoria-producto/suspension/bastidores/'), true);
  assert.equal(canonicalizeItalurUrl(`${retendorUrl}?utm_source=x#descripcion`), retendorUrl);
  assert.equal(canonicalizeItalurUrl('https://www.italur.com/?add-to-cart=123'), undefined);
  assert.equal(canonicalizeItalurUrl('https://www.italur.com/carrito-compras/'), undefined);
});

test('Italur normaliza precios uruguayos sin tocar el normalizador global', () => {
  assert.equal(normalizeItalurPrice('$1.287'), '1287');
  assert.equal(normalizeItalurPrice('$21.960'), '21960');
  assert.equal(normalizeItalurPrice('$906'), '906');
  assert.equal(normalizeItalurPrice('$1.287,50'), '1287.50');
});

test('Italur descubre categorias, paginacion y productos del listado', () => {
  const html = fixture('listing.html');
  assert.deepEqual(extractItalurProductUrls(html, shopUrl), [
    'https://www.italur.com/producto/abrazadera-u-eje-bastidor-ch-c10-d20-64-96-silverado-97-01',
    'https://www.italur.com/producto/abrazadera-barra-estabilizadora-chevrolet-chevette',
  ]);
  assert.deepEqual(extractItalurCategoryUrls(html, shopUrl), [
    'https://www.italur.com/tienda/page/2/',
    'https://www.italur.com/tienda/page/3/',
    'https://www.italur.com/categoria-producto/suspension',
    'https://www.italur.com/categoria-producto/suspension/bastidores',
  ]);
  assert.deepEqual(extractItalurListingSummary(html, shopUrl), {
    currentPage: 1,
    lastPage: 3,
    nextPageUrl: 'https://www.italur.com/tienda/page/2/',
  });
});

test('Italur extrae productos de listado con stock, agotado, categoria, imagen y compatibilidad', () => {
  const products = extractItalurListProducts(fixture('listing.html'), shopUrl, 'domain');
  assert.equal(products.length, 2);
  const available = products[0];
  assert.equal(available.productName, 'ABRAZADERA U EJE BASTIDOR CH C10/D20 64/96/SILVERADO 97/01');
  assert.equal(available.price, '1287');
  assert.equal(available.currency, 'UYU');
  assert.equal(available.sku, '93205779-IM');
  assert.equal(available.availability, 'in_stock');
  assert.equal(available.category, 'Accesorios Suspension');
  assert.equal(available.imageUrl, 'https://www.italur.com/wp-content/uploads/2026/05/93205779-IM.jpg');
  assert.deepEqual(available.compatibleBrands, ['Chevrolet']);
  assert.deepEqual(available.compatibleModels, ['C10', 'D20', 'Silverado']);

  const outOfStock = products[1];
  assert.equal(outOfStock.price, '906');
  assert.equal(outOfStock.availability, 'out_of_stock');
  assert.deepEqual(outOfStock.compatibleBrands, ['Chevrolet']);
  assert.deepEqual(outOfStock.compatibleModels, ['Chevette']);
});

test('Italur extrae la ficha real sanitizada de retenedor', () => {
  const product = extractItalurDetail(fixture('detail-retenedor.html'), retendorUrl, 'domain');
  assert.ok(product);
  assert.equal(product.productName, 'RETENEDOR');
  assert.equal(product.price, '23');
  assert.equal(product.currency, 'UYU');
  assert.equal(product.sku, '6231187');
  assert.match(product.description ?? '', /6231187/);
  assert.equal(product.stock, '4 disponibles');
  assert.equal(product.availability, 'in_stock');
  assert.equal(product.category, 'Varios');
  assert.equal(product.sourceUrl, retendorUrl);
  assert.equal(product.imageUrl, 'https://www.italur.com/wp-content/uploads/2026/05/6231187.jpg');
  assert.deepEqual(product.imageUrls, [
    'https://www.italur.com/wp-content/uploads/2026/05/6231187.jpg',
    'https://www.italur.com/wp-content/uploads/2026/05/6231187_1.jpg',
  ]);
});

test('Italur marca agotado cuando no hay compra y aparece Leer mas', () => {
  const product = extractItalurDetail(fixture('detail-agotado.html'), 'https://www.italur.com/producto/llave-rueda-chevrolet-montana-04-10/', 'domain');
  assert.ok(product);
  assert.equal(product.price, '21960');
  assert.equal(product.availability, 'out_of_stock');
  assert.equal(product.sku, '93312584');
  assert.deepEqual(product.compatibleBrands, ['Chevrolet']);
  assert.deepEqual(product.compatibleModels, ['Montana']);
});

test('Italur deduplica por URL canonica y por SKU', () => {
  const first = extractItalurDetail(fixture('detail-retenedor.html'), `${retendorUrl}?utm=1`, 'domain');
  assert.ok(first);
  const result = dedupeItalurProducts([
    first,
    { ...first, sourceUrl: `${retendorUrl}#detalle` },
    { ...first, sourceUrl: 'https://www.italur.com/producto/retenedor-copia' },
  ]);
  assert.equal(result.products.length, 1);
  assert.equal(result.duplicates, 2);
});
