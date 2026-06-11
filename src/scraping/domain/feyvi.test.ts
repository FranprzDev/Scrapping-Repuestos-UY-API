import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extractCandidateLinks, extractProductsFromHtml } from './domain-html';
import { findDomainRule } from './domain-rules';
import { canonicalSiteKey } from './site-key';
import { qualityGate } from './product-quality';

test('feyvi detecta producto y paginacion desde una card de listado', () => {
  const rule = findDomainRule('https://www.feyvi.com.uy/repuestos/acabamiento-exterior/');
  assert.ok(rule);

  const html = `
    <div class="col-tile">
      <div class="ty-grid-list__item">
        <div class="ty-grid-list__item-name">
          <a class="product-title" href="https://www.feyvi.com.uy/repuestos/acabamiento-exterior/insignias-y-emblemas/emblema-insignia-t-valija/">EMBLEMA INSIGNIA T/VALIJA</a>
        </div>
        <div class="ty-grid-list__price qty-wrap">
          <span class="ty-price">
            <span class="ty-price-num">$</span>
            <span class="ty-price-num">7,263</span>
          </span>
        </div>
        <button>Añadir al carrito</button>
      </div>
    </div>
    <div class="ty-pagination__items">
      <a class="cm-history ty-pagination__item cm-ajax" href="https://www.feyvi.com.uy/repuestos/acabamiento-exterior/page-2/">2</a>
    </div>
  `;

  const links = extractCandidateLinks(html, 'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/', rule);
  assert.equal(links.productLinks.length, 1);
  assert.equal(links.categoryLinks.length, 1);
  assert.equal(links.categoryLinks[0], 'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/page-2/');

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'EMBLEMA INSIGNIA T/VALIJA');
  assert.equal(products[0].price, '7,263');
  assert.equal(products[0].sourceUrl, 'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/insignias-y-emblemas/emblema-insignia-t-valija/');
});

test('feyvi canonicaliza el key de archive sin incluir la paginacion', () => {
  assert.equal(
    canonicalSiteKey('https://www.feyvi.com.uy/repuestos/acabamiento-exterior/page-2/?result_ids=pagination_block'),
    'feyvi.com.uy_repuestos-acabamiento-exterior',
  );
});

test('feyvi extrae la ficha de un producto desde su pagina detalle', () => {
  const rule = findDomainRule('https://www.feyvi.com.uy/repuestos/acabamiento-exterior/insignias-y-emblemas/emblema-insignia-t-valija/');
  assert.ok(rule);

  const html = `
    <main>
      <h1 class="product-title">EMBLEMA INSIGNIA T/VALIJA</h1>
      <span class="ty-price">$ 7,263</span>
      <div class="ty-control-group__item">Código: 22917172GMC</div>
      <button>Comprar</button>
    </main>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/insignias-y-emblemas/emblema-insignia-t-valija/', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].price, '7,263');
  assert.equal(products[0].sku, '22917172GMC');
});

test('feyvi descarta productos no automotrices aunque esten dentro de /repuestos/', () => {
  const rule = findDomainRule('https://www.feyvi.com.uy/repuestos/computadoras/all-in-one/');
  assert.ok(rule);

  const html = `
    <div class="col-tile">
      <div class="ty-grid-list__item">
        <div class="ty-grid-list__item-name">
          <a class="product-title" href="https://www.feyvi.com.uy/repuestos/computadoras/all-in-one/equipo-all-in-one-chuwi-ryzen-5-45ghz-16gb-512gb-ssd-27-qhd-180hz-c-equ2012/">EQUIPO ALL IN ONE CHUWI RYZEN 5</a>
        </div>
        <div class="ty-grid-list__price qty-wrap">
          <span class="ty-price">
            <span class="ty-price-num">$</span>
            <span class="ty-price-num">49,990</span>
          </span>
        </div>
        <button>Añadir al carrito</button>
      </div>
    </div>
  `;

  const products = qualityGate(
    extractProductsFromHtml(html, 'https://www.feyvi.com.uy/repuestos/computadoras/all-in-one/', 'domain', rule),
    rule,
  );

  assert.equal(products.length, 0);
});
