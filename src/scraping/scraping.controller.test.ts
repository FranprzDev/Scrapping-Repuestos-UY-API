import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_CATALOG_SITES } from './dto/catalog-request.dto';
import { resolveCatalogSites } from './scraping.controller';

test('filtra casas excluidas del refresh por query', () => {
  const sites = resolveCatalogSites(undefined, 'feyvi, selvir');

  assert.ok(sites.length > 0);
  assert.equal(sites.some((site) => site.includes('feyvi.com.uy')), false);
  assert.equal(sites.some((site) => site.includes('selvir.com.uy')), false);
  assert.equal(sites.some((site) => site.includes('taxitor.uy')), true);
  assert.equal(sites.some((site) => site.includes('acesur.uy')), true);
});

test('respeta urls enviadas en el body y aplica exclusion por hostname o id', () => {
  const sites = resolveCatalogSites(
    [
      'https://taxitor.uy/articulos/filtro/1/-/-/',
      'https://acesur.uy/escritorio/ofertas/INTERNET',
      'https://www.selvir.com.uy/product-category/carroceria/',
    ],
    'selvir.com.uy',
  );

  assert.deepEqual(sites, [
    'https://taxitor.uy/articulos/filtro/1/-/-/',
    'https://acesur.uy/escritorio/ofertas/INTERNET',
  ]);
});

test('sin exclusiones devuelve el set por defecto', () => {
  assert.deepEqual(resolveCatalogSites(undefined), [...DEFAULT_CATALOG_SITES]);
});
