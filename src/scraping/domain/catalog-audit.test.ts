import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { ProductRecord } from '../interfaces/scraping.types';
import {
  canonicalizeAuditUrl,
  classifyCatalogAudit,
  compareWebAndBase,
  detectLastPagesByListing,
  findDuplicateSkus,
  findDuplicateSourceUrls,
} from './catalog-audit';

const baseProduct: ProductRecord = {
  productName: 'Filtro de aceite',
  sourceUrl: 'https://example.com/product/filtro',
  price: '450',
  sku: 'FO-1',
  imageUrl: 'https://example.com/filtro.jpg',
  extractedAt: '2026-08-06T00:00:00.000Z',
  provider: 'domain',
};

test('auditor canonicaliza y deduplica URLs de producto', () => {
  assert.equal(
    canonicalizeAuditUrl('HTTPS://www.Example.com/product/filtro/?utm=1#top'),
    'https://example.com/product/filtro?utm=1',
  );

  assert.deepEqual(findDuplicateSourceUrls([
    baseProduct,
    { ...baseProduct, sourceUrl: 'https://www.example.com/product/filtro/' },
    { ...baseProduct, sourceUrl: 'https://example.com/product/pastilla' },
  ]), [
    { url: 'https://example.com/product/filtro', count: 2 },
  ]);
});

test('auditor detecta duplicados por SKU', () => {
  assert.deepEqual(findDuplicateSkus([
    baseProduct,
    { ...baseProduct, sourceUrl: 'https://example.com/product/filtro-2', sku: 'fo-1' },
    { ...baseProduct, sourceUrl: 'https://example.com/product/pastilla', sku: 'PA-1' },
  ]), [
    { sku: 'fo-1', count: 2 },
  ]);
});

test('auditor calcula ultima pagina por listado independiente', () => {
  const lastPages = detectLastPagesByListing([
    { listingUrl: 'https://example.com/a', url: 'https://example.com/a', page: 1, productCount: 2, newInListing: 2 },
    { listingUrl: 'https://example.com/a', url: 'https://example.com/a?page=2', page: 2, productCount: 2, newInListing: 0 },
    { listingUrl: 'https://example.com/b', url: 'https://example.com/b', page: 1, productCount: 1, newInListing: 1 },
  ]);

  assert.equal(lastPages.length, 2);
  assert.deepEqual(lastPages[0].repeatedPagePairs, [{ page: 1, nextPage: 2 }]);
  assert.equal(lastPages[1].lastPage, 1);
});

test('auditor compara web y base y calcula cobertura', () => {
  const comparison = compareWebAndBase([
    'https://example.com/p/1',
    'https://www.example.com/p/2/',
    'https://example.com/p/3',
  ], [
    { sourceUrl: 'https://example.com/p/1' },
    { sourceUrl: 'https://example.com/p/2' },
    { sourceUrl: 'https://example.com/p/old' },
  ]);

  assert.equal(comparison.currentBaseRecords, 3);
  assert.equal(comparison.coveragePercent, 66.67);
  assert.deepEqual(comparison.webUrlsMissingInBase, ['https://example.com/p/3']);
  assert.deepEqual(comparison.baseUrlsMissingInWeb, ['https://example.com/p/old']);
});

test('auditor clasifica CRITICAL, REVIEW y OK', () => {
  assert.equal(classifyCatalogAudit({
    coveragePercent: 69.99,
    pages: [],
    httpErrors: [],
    productsWithoutPrice: 0,
    productsWithoutSku: 0,
    productsWithoutImage: 0,
    rejectedProducts: [],
  }), 'CRITICAL');

  assert.equal(classifyCatalogAudit({
    coveragePercent: 90,
    pages: [],
    httpErrors: [],
    productsWithoutPrice: 0,
    productsWithoutSku: 0,
    productsWithoutImage: 0,
    rejectedProducts: [],
  }), 'REVIEW');

  assert.equal(classifyCatalogAudit({
    coveragePercent: 99,
    pages: [],
    httpErrors: [],
    productsWithoutPrice: 0,
    productsWithoutSku: 0,
    productsWithoutImage: 0,
    rejectedProducts: [],
  }), 'OK');
});
