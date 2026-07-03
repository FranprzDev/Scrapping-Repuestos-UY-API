import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extractProductsFromHtml } from './domain-html';
import { findDomainRule } from './domain-rules';
import { qualityGate } from './product-quality';
import { inferVehicleBrands } from './vehicle-brands';
import { buildEuropartsCatalogUrl, extractEuropartsTotal } from '../providers/domain.provider';

const pageUrl = 'https://www.europarts.com.uy/es/search?recordsize=100';

test('Europarts obtiene el total y construye una unica consulta completa', () => {
  const html = `
    <div class="product-show-option">
      <div class="col-lg-4 col-md-4 text-right">
        <p>Mostrando 1 a 100 de 1721</p>
      </div>
    </div>
  `;

  assert.equal(extractEuropartsTotal(html), 1721);
  assert.equal(
    buildEuropartsCatalogUrl(pageUrl, 1721),
    'https://www.europarts.com.uy/es/search?recordsize=1721',
  );
});

test('Europarts extrae cards y clasifica Peugeot, Citroen u Otros', () => {
  const rule = findDomainRule(pageUrl);
  assert.ok(rule);

  const html = `
    <div class="product-list">
      <div class="product-item">
        <div class="pi-pic"><img alt="BRAZO PEUGEOT 208" data-src="/img/peugeot.jpg"></div>
        <div class="pi-text">
          <a class="catagory-name">Suspensión y Dirección</a>
          <div class="product-price">$ 13900,00</div>
          <a href="/es/mlu164718/product/948"><h5>BRAZO SUSPENSION PEUGEOT 208</h5></a>
        </div>
      </div>
      <div class="product-item">
        <div class="pi-pic"><img alt="RETEN CITROEN/PEUGEOT" data-src="/img/reten.jpg"></div>
        <div class="pi-text">
          <a class="catagory-name">Retenes</a>
          <div class="product-price">$ 3660,00</div>
          <a href="/es/retenes/product/1166"><h5>RETEN CITROEN/PEUGEOT</h5></a>
        </div>
      </div>
      <div class="product-item">
        <div class="pi-text">
          <a class="catagory-name">Aditivos y Lubricantes</a>
          <div class="product-price">$ 2606,00</div>
          <a href="/es/uncategorized/product/7117"><h5>ACEITE TEKMA SUPRA 15W40 5L</h5></a>
        </div>
      </div>
    </div>
  `;

  const products = qualityGate(extractProductsFromHtml(html, pageUrl, 'domain', rule), rule);

  assert.equal(products.length, 3);
  assert.deepEqual(inferVehicleBrands(products[0]).map((brand) => brand.label), ['Peugeot']);
  assert.deepEqual(inferVehicleBrands(products[1]).map((brand) => brand.label).sort(), ['Citroen', 'Peugeot']);
  assert.deepEqual(inferVehicleBrands(products[2]).map((brand) => brand.label), ['Otros']);
  assert.equal(products[0].price, '13900,00');
  assert.equal(products[0].sourceUrl, 'https://www.europarts.com.uy/es/mlu164718/product/948');
});
