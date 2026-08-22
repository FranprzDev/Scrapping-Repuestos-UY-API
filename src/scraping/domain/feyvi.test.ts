import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractCandidateLinks, extractProductsFromHtml } from './domain-html';
import { findDomainRule } from './domain-rules';
import { canonicalSiteKey } from './site-key';
import { qualityGate } from './product-quality';

test('feyvi detecta producto y paginacion desde una card de listado', () => {
  const rule = findDomainRule('https://www.feyvi.com.uy/repuestos/acabamiento-exterior/');
  assert.ok(rule);
  assert.equal(rule.preferredMethod, 'http');

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
    <a class="product-title" href="https://www.feyvi.com.uy/repuestos/acabamiento-exterior/?features_hash=338-86">General Motors</a>
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

test('feyvi extrae imagen de card de listado y descarta links con filtros', () => {
  const rule = findDomainRule('https://www.feyvi.com.uy/repuestos/acabamiento-exterior/');
  assert.ok(rule);

  const html = `
    <div class="ty-grid-list__item">
      <div class="ty-grid-list__image">
        <a class="abt-single-image" href="https://www.feyvi.com.uy/repuestos/acabamiento-exterior/insignias-y-emblemas/adhesivo-chevrolet-t-valija-ceniza/">
          <img src="https://www.feyvi.com.uy/images/thumbnails/230/230/detailed/27/93397877g.jpg" srcset="https://www.feyvi.com.uy/images/thumbnails/460/460/detailed/27/93397877g.jpg 2x" />
        </a>
      </div>
      <div class="ty-grid-list__item-name">
        <a class="product-title" href="https://www.feyvi.com.uy/repuestos/acabamiento-exterior/insignias-y-emblemas/adhesivo-chevrolet-t-valija-ceniza/">ADHESIVO CHEVROLET T/VALIJA (CENIZA)</a>
      </div>
      <span class="ty-price"><span class="ty-price-num">$</span><span class="ty-price-num">194</span></span>
      <a class="product-title" href="https://www.feyvi.com.uy/repuestos/acabamiento-exterior/insignias-y-emblemas/?features_hash=338-86">General Motors</a>
    </div>
  `;

  const links = extractCandidateLinks(html, 'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/', rule);
  assert.deepEqual(links.productLinks, [
    'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/insignias-y-emblemas/adhesivo-chevrolet-t-valija-ceniza/',
  ]);

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].imageUrl, 'https://www.feyvi.com.uy/images/thumbnails/230/230/detailed/27/93397877g.jpg');
  assert.ok(products[0].imageUrls?.includes('https://www.feyvi.com.uy/images/thumbnails/460/460/detailed/27/93397877g.jpg'));
  assert.equal(products[0].imageUrls?.some((url) => /logo|placeholder|features_hash/i.test(url)), false);
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

test('feyvi extrae imagen real, fabricante y compatibilidad desde una ficha CS-Cart real', () => {
  const sourceUrl = 'https://www.feyvi.com.uy/repuestos/acabamiento-interior/consola-de-techo/cubierta-interior-espejo-retrovisor/';
  const rule = findDomainRule(sourceUrl);
  assert.ok(rule);

  const html = readFileSync(join(process.cwd(), 'src', 'scraping', 'domain', 'fixtures', 'feyvi', 'reference-detail.html'), 'utf8');
  const products = qualityGate(extractProductsFromHtml(html, sourceUrl, 'domain', rule), rule);
  const product = products.find((item) => item.sku === '26278125GMC');

  assert.ok(product);
  assert.equal(product.productName, 'APLIQUE CUBIERTA INTERIOR ESPEJO RETROVISOR');
  assert.equal(product.price, '71');
  assert.equal(product.sku, '26278125GMC');
  assert.equal(product.brand, 'General Motors');
  assert.ok(product.compatibleBrands?.includes('Chevrolet'));
  assert.ok(product.compatibleModels?.includes('ONIX 1.2 MPI'));
  assert.ok(product.compatibleModels?.includes('ONIX PLUS 1.2 MPI'));
  assert.ok(product.compatibleVehicles?.includes('Chevrolet - ONIX 1.2 MPI'));
  assert.ok(product.compatibleVehicles?.includes('Chevrolet - ONIX PLUS 1.2 MPI'));
  assert.equal(product.compatibleVersions, undefined);
  assert.ok(product.imageUrl);
  assert.match(product.imageUrl, /\/images\/(?:thumbnails\/\d+\/\d+\/)?detailed\/32\/26278125g_1\.jpg$/i);
  assert.equal(/logo|placeholder|no-image|sin-imagen|loader|banner|promo|abt__yt_mwi__icon/i.test(product.imageUrl), false);
  assert.ok(product.imageUrls?.includes('https://www.feyvi.com.uy/images/detailed/32/26278125g_1.jpg'));
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

test('feyvi descarta las cards de paginacion tipo 24 productos mas como producto', () => {
  const rule = findDomainRule('https://www.feyvi.com.uy/repuestos/acabamiento-exterior/');
  assert.ok(rule);

  const html = `
    <div class="col-tile">
      <div class="ty-grid-list__item">
        <div class="ty-grid-list__item-name">
          <a class="product-title" href="https://www.feyvi.com.uy/repuestos/acabamiento-exterior/page-2/">24 productos mas</a>
        </div>
        <button>Añadir al carrito</button>
      </div>
    </div>
  `;

  const products = qualityGate(
    extractProductsFromHtml(html, 'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/', 'domain', rule),
    rule,
  );

  assert.equal(products.length, 0);
});

test('feyvi descarta acciones de agregar producto que no son fichas', () => {
  const rule = findDomainRule('https://www.feyvi.com.uy/repuestos/acabamiento-exterior/');
  assert.ok(rule);

  const html = `
    <div class="ty-grid-list__item">
      <a class="product-title" href="https://www.feyvi.com.uy/index.php?dispatch=product_features.add_product&product_id=35927&redirect_url=index.php%3Fdispatch%3Dcategories.view%26category_id%3D903">Agregar producto</a>
      <span class="ty-price">$ 1,250</span>
      <button>Agregar al carrito</button>
    </div>
  `;

  const links = extractCandidateLinks(html, 'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/', rule);
  const products = qualityGate(
    extractProductsFromHtml(html, 'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/', 'domain', rule),
    rule,
  );

  assert.equal(links.productLinks.length, 0);
  assert.equal(products.length, 0);
});

test('feyvi descarta categorias con precio aparente como si fueran productos', () => {
  const rule = findDomainRule('https://www.feyvi.com.uy/repuestos/alimentacion-admision-de-aire-y-escape-es/');
  assert.ok(rule);

  const products = qualityGate([{
    productName: 'FILTRO DE AIRE',
    price: '1,250',
    sourceUrl: 'https://www.feyvi.com.uy/repuestos/alimentacion-admision-de-aire-y-escape-es/filtro-de-aire/',
    extractedAt: new Date().toISOString(),
    provider: 'domain',
  }], rule);

  assert.equal(products.length, 0);
});
