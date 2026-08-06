import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  extractFieldNamesFromBody,
  extractYokomitsuProductsFromJson,
  inferApproximateProductCount,
  inferPaginationFromCalls,
  inferYokomitsuFieldsAvailable,
  isLikelyYokomitsuCatalogUrl,
  normalizeYokomitsuPrice,
  sanitizeHeaders,
  sanitizeRequestBody,
  sanitizeUrl,
  summarizeJsonShape,
} from './yokomitsu';

test('Yokomitsu normaliza precios uruguayos sin afectar otros proveedores', () => {
  assert.equal(normalizeYokomitsuPrice('$ 1.234'), '1234');
  assert.equal(normalizeYokomitsuPrice('UYU 12.345'), '12345');
  assert.equal(normalizeYokomitsuPrice('$U 1.234,50'), '1234.50');
  assert.equal(normalizeYokomitsuPrice('123,45'), '123.45');
});

test('Yokomitsu redacta credenciales, cookies y tokens en requests', () => {
  assert.equal(
    sanitizeUrl('https://www.yokomitsuparts.com.uy/v2/api/catalogo?token=abc&page=2'),
    'https://www.yokomitsuparts.com.uy/v2/api/catalogo?token=%5BREDACTED%5D&page=2',
  );
  assert.deepEqual(sanitizeHeaders({
    authorization: 'Bearer secret',
    cookie: 'session=secret',
    accept: 'application/json',
  }), {
    authorization: '[REDACTED]',
    cookie: '[REDACTED]',
    accept: 'application/json',
  });
  assert.deepEqual(sanitizeRequestBody('usuario=demo&password=secret&empresa=abc'), {
    usuario: '[VALUE]',
    password: '[REDACTED]',
    empresa: '[VALUE]',
  });
  assert.deepEqual(extractFieldNamesFromBody('usuario=demo&password=secret'), ['usuario', 'password']);
});

test('Yokomitsu extrae muestra desde JSON sanitizado de catalogo', () => {
  const body = {
    total: 1234,
    page: 1,
    data: [{
      codigo: 'YK-001',
      nombre: 'Filtro de aceite',
      marcaProducto: 'Marca Demo',
      precio: '1.234,50',
      moneda: 'UYU',
      stock: '7',
      referencia: 'REF-001',
      categoria: 'Filtros',
      marcaVehiculo: 'Toyota',
      modeloVehiculo: 'Corolla',
      imagen: '/img/filtro.jpg',
    }],
  };

  const products = extractYokomitsuProductsFromJson(body, 'https://www.yokomitsuparts.com.uy/v2/');
  assert.equal(products.length, 1);
  assert.equal(products[0].provider, 'Yokomitsu');
  assert.equal(products[0].productName, 'Filtro de aceite');
  assert.equal(products[0].sku, 'YK-001');
  assert.equal(products[0].price, '1234.50');
  assert.equal(products[0].currency, 'UYU');
  assert.equal(products[0].availability, 'in_stock');
  assert.equal(products[0].attributes?.referencia, 'REF-001');
  assert.equal(products[0].attributes?.vehicleBrand, 'Toyota');
  assert.equal(products[0].attributes?.vehicleModel, 'Corolla');
  assert.equal(products[0].imageUrl, 'https://www.yokomitsuparts.com.uy/img/filtro.jpg');
  assert.equal(inferApproximateProductCount(body), 1234);
});

test('Yokomitsu resume shape, campos y paginacion sin guardar datos privados', () => {
  const shape = summarizeJsonShape({
    recordsTotal: 45,
    rows: [{ codigo: 'YK-001', nombre: 'Filtro', precio: '1.234' }],
  });
  const pagination = inferPaginationFromCalls([{
    method: 'GET',
    url: 'https://www.yokomitsuparts.com.uy/v2/api/catalogo?page=2&limit=20',
    responseShape: shape,
  }]);
  const fields = inferYokomitsuFieldsAvailable(extractYokomitsuProductsFromJson({
    rows: [{ codigo: 'YK-001', nombre: 'Filtro', precio: '1.234', stock: 0 }],
  }));

  assert.deepEqual(pagination.observedParams, ['limit', 'page']);
  assert.ok(pagination.observedFields.includes('recordsTotal'));
  assert.equal(fields.productName, true);
  assert.equal(fields.price, true);
  assert.equal(fields.stock, true);
  assert.equal(isLikelyYokomitsuCatalogUrl('https://www.yokomitsuparts.com.uy/v2/api/catalogo?page=1'), true);
  assert.equal(isLikelyYokomitsuCatalogUrl('https://example.com/v2/api/catalogo?page=1'), false);
});
