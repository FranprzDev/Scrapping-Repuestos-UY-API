import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_CATALOG_SITES, GRFRENOS_CATALOG_SITES, NEW_CATALOG_SITES, SELVIR_CATALOG_SITES } from './dto/catalog-request.dto';
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

test('incluye todas las categorias raiz de Selvir en el refresh por defecto', () => {
  const sites = resolveCatalogSites(undefined);

  assert.deepEqual(
    sites.filter((site) => site.includes('selvir.com.uy')),
    [...SELVIR_CATALOG_SITES],
  );
});

test('incluye GR Frenos en el refresh por defecto', () => {
  const sites = resolveCatalogSites(undefined);

  assert.deepEqual(
    sites.filter((site) => site.includes('grfrenos.uy')),
    [...GRFRENOS_CATALOG_SITES],
  );
});

test('incluye las nuevas casas en el refresh por defecto', () => {
  const sites = resolveCatalogSites(undefined);

  for (const site of NEW_CATALOG_SITES) {
    assert.ok(sites.includes(site));
  }
});
