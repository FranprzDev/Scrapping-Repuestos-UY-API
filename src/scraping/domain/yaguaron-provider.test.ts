import assert from 'node:assert/strict';
import test from 'node:test';
import { findDomainRule } from './domain-rules';
import { extractProductsFromHtml } from './domain-html';

test('Yaguarón extrae precio, stock y toda la descripción del detalle', () => {
  const sourceUrl = 'https://www.yaguaron.com.uy/catalogo/kit-de-filtros-y-aceite-cruze_123543_123543';
  const rule = findDomainRule(sourceUrl);
  assert.ok(rule);

  const products = extractProductsFromHtml(`
    <main>
      <div class="columnaDerecha">
        <div class="hdr"><h1 class="tit">KIT DE FILTROS Y ACEITE - CRUZE</h1><div class="cod">123543</div></div>
        <div class="preciosWrapper"><strong class="precio venta"><span class="sim">$</span> <span class="monto">5.690</span></strong></div>
        <div class="logoMarca"><img alt="AC DELCO"></div>
        <button class="btnComprar">Comprar</button>
      </div>
      <div class="tabs blkDetalle">
        <div class="text">
          <p>Calidad: ORIGINAL</p>
          <p>Fabricante: AC DELCO / MAHLE</p>
          <p>Referencia: 550047248 / 550047282 / 55594651 / 13272717</p>
          <p>Aplicación: Cruze 1.8</p>
          <p>Componentes: Aceite Ac Delco 5W30 DEXOS 1 (5 Litros)</p>
        </div>
      </div>
    </main>
  `, sourceUrl, 'domain', rule);

  const product = products.find((item) => item.sourceUrl === sourceUrl);
  assert.ok(product);
  assert.equal(product.price, '5.690');
  assert.equal(product.currency, 'UYU');
  assert.equal(product.availability, 'in_stock');
  assert.equal(product.sku, '123543');
  assert.match(product.description ?? '', /Calidad: ORIGINAL/);
  assert.match(product.description ?? '', /Aplicación: Cruze 1\.8/);
  assert.match(product.description ?? '', /Componentes: Aceite Ac Delco/);
});
