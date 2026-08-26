import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCentroRepuestosLinks,
  extractCentroRepuestosProduct,
  isCentroRepuestosProductUrl,
  isCentroRepuestosCategoryUrl,
} from './centrorepuestos';

test('Centro Repuestos reconoce productos y categorias reales', () => {
  assert.equal(
    isCentroRepuestosProductUrl(
      'http://www.centrorepuestos.com.uy/index.php?main_page=product_info&products_id=31004',
    ),
    true,
  );

  assert.equal(
    isCentroRepuestosCategoryUrl(
      'http://www.centrorepuestos.com.uy/index.php?main_page=index&cPath=3_288&pg=categories',
    ),
    true,
  );

  assert.equal(
    isCentroRepuestosProductUrl(
      'https://bielastore.abcsrvhost.com/producto/remera/',
    ),
    false,
  );
});

test('Centro Repuestos descubre productos sin aceptar dominios externos', () => {
  const html = `
    <a href="index.php?main_page=product_info&products_id=31004">Producto</a>
    <a href="index.php?main_page=index&cPath=3_288&pg=categories#">Categoria</a>
    <a href="https://bielastore.abcsrvhost.com/producto/remera/">Externo</a>
  `;

  const result = extractCentroRepuestosLinks(
    html,
    'http://www.centrorepuestos.com.uy/index.php?main_page=index&cPath=3',
  );

  assert.deepEqual(result.productUrls, [
    'http://www.centrorepuestos.com.uy/index.php?main_page=product_info&products_id=31004',
  ]);

  assert.equal(result.categoryUrls.length, 1);
  assert.equal(result.categoryUrls[0].includes('#'), false);
  assert.equal(
    result.productUrls.some((url) => url.includes('bielastore')),
    false,
  );
});

test('Centro Repuestos extrae ficha Zen Cart limpia', () => {
  const html = `
    <div class="productinfo-rightwrapper">
      <h1>ALARGUE BUJIA PEUGEOT 404/504 JUEGO</h1>

      <div class="product_quantity">
        <ul>
          <li>Hay Stock</li>
          <li>Codigo: 69.1692</li>
        </ul>
      </div>

      <div class="productprice-amount">
        <div class="single_price">$240.02</div>
      </div>

      <div id="productMainImage">
        <script>
          document.write('<a href="images/items/69.1692.jpg"><img src="bmz_cache/test.image.660x495.jpg"></a>');
        </script>
      </div>

      <div id="description" class="tabcontent">
        <p>
          PIPAS DE BUJIA PE PEUGEOT C/U.<br>
          Marca: [ARG]
        </p>
        <h3>Productos similares</h3>
        <table><tr><td>PRODUCTO AJENO</td></tr></table>
      </div>
    </div>
  `;

  const product = extractCentroRepuestosProduct(
    html,
    'http://www.centrorepuestos.com.uy/index.php?main_page=product_info&products_id=31004',
    'domain',
  );

  assert.ok(product);
  assert.equal(product.productName, 'ALARGUE BUJIA PEUGEOT 404/504 JUEGO');
  assert.equal(product.price, '240.02');
  assert.equal(product.currency, 'UYU');
  assert.equal(product.sku, '69.1692');
  assert.equal(product.brand, '[ARG]');
  assert.equal(product.description, 'PIPAS DE BUJIA PE PEUGEOT C/U.');
  assert.equal(
    product.imageUrl,
    'http://www.centrorepuestos.com.uy/images/items/69.1692.jpg',
  );
  assert.equal(product.description?.includes('PRODUCTO AJENO'), false);
});

test('Centro Repuestos no guarda placeholder como imagen real', () => {
  const html = `
    <div class="productinfo-rightwrapper">
      <h1>MAQUINA LEVANTA CRISTAL</h1>

      <div class="product_quantity">
        <li>Codigo: 83.9018</li>
      </div>

      <div class="productprice-amount">
        <div class="single_price">$12,737.02</div>
      </div>

      <div id="productMainImage">
        <img src="images/no-image.jpg">
      </div>

      <div id="description">
        MAQUINA LEVANTA CRISTAL
      </div>
    </div>
  `;

  const product = extractCentroRepuestosProduct(
    html,
    'http://www.centrorepuestos.com.uy/index.php?main_page=product_info&products_id=38947',
    'domain',
  );

  assert.ok(product);
  assert.equal(product.imageUrl, undefined);
});

