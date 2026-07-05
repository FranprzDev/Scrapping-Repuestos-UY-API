import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { inferVehicleBrands, normalizeVehicleBrandId, resolveVehicleBrandFilterId } from './vehicle-brands';
import type { ProductRecord } from '../interfaces/scraping.types';

test('normaliza aliases de marcas de vehiculo', () => {
  assert.equal(normalizeVehicleBrandId('VW'), 'volkswagen');
  assert.equal(normalizeVehicleBrandId('V.W.'), 'volkswagen');
  assert.equal(normalizeVehicleBrandId('Mercedes'), 'mercedes-benz');
  assert.equal(normalizeVehicleBrandId('MB'), 'mercedes-benz');
  assert.equal(normalizeVehicleBrandId('FI'), 'fiat');
});

test('infiere multiples marcas compatibles desde el producto', () => {
  const brands = inferVehicleBrands(product({ productName: 'BOMBA ACEITE CITROEN-PEUGEOT 1.6' }));

  assert.deepEqual(
    brands.map((brand) => brand.id),
    ['citroen', 'peugeot'],
  );
});

test('usa Otros cuando no hay marca compatible detectable', () => {
  const brands = inferVehicleBrands(product({ productName: 'ALFOMBRA UNIVERSAL NEGRA' }));

  assert.deepEqual(brands.map((brand) => brand.id), ['otros']);
});

test('evita falsos positivos por tokens parciales', () => {
  const brands = inferVehicleBrands(product({ productName: 'SOPORTE POWERFLOW UNIVERSAL' }));

  assert.deepEqual(brands.map((brand) => brand.id), ['otros']);
});

test('preserva marcas compatibles explícitas aunque no estén en el diccionario inicial', () => {
  const brands = inferVehicleBrands(product({ compatibleBrands: ['AEOLUS', 'Ford Camion'] }));

  assert.deepEqual(brands.map((brand) => [brand.id, brand.label]), [
    ['aeolus', 'AEOLUS'],
    ['ford', 'Ford'],
  ]);
});

test('normaliza marcas dinámicas para el filtro de inventario', () => {
  assert.equal(resolveVehicleBrandFilterId('CASE IH Tractor'), 'case-ih-tractor');
  assert.equal(resolveVehicleBrandFilterId('VW'), 'volkswagen');
});

function product(patch: Partial<ProductRecord>): ProductRecord {
  return {
    extractedAt: new Date().toISOString(),
    provider: 'domain',
    sourceUrl: 'https://example.com/product/demo',
    price: '100',
    ...patch,
  };
}
