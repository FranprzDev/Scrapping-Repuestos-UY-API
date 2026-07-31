import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildFenicioPageUrl,
  buildLarriqueFinalPageUrl,
  buildShopifyProductsUrl,
  extractCymacoBrandSeeds,
  extractFamilcarBrandSeeds,
  extractFenicioPageSummary,
  extractFenicioProducts,
  extractLarriqueProducts,
  extractLarriqueTotalResults,
  extractShopifyProducts,
  parseLarriqueBrandResponse,
} from './new-catalog-sites';
import { extractCandidateLinks, extractProductsFromHtml } from './domain-html';
import { findDomainRule, isAdmittedHouseUrl } from './domain-rules';

test('Multishop pagina y normaliza el JSON público de Shopify', () => {
  assert.equal(
    buildShopifyProductsUrl('https://www.multishop.com.uy/', 2),
    'https://www.multishop.com.uy/products.json?limit=250&page=2',
  );

  const result = extractShopifyProducts(JSON.stringify({
    products: [{
      title: 'Bomba de agua Ford',
      handle: 'bomba-agua-ford',
      body_html: '<p>Aplicación Ford Fiesta</p>',
      product_type: 'Bombas',
      vendor: 'Indisa',
      images: [{ src: '//cdn.example.com/bomba.jpg' }],
      variants: [{ price: '792.00', sku: '204009', available: true }],
    }],
  }), 'https://www.multishop.com.uy/', 'domain');

  assert.equal(result.received, 1);
  assert.equal(result.products[0].sourceUrl, 'https://www.multishop.com.uy/products/bomba-agua-ford');
  assert.equal(result.products[0].price, '792.00');
  assert.equal(result.products[0].sku, '204009');
});

test('Cymaco descubre marcas compatibles desde el catálogo', () => {
  const brands = extractCymacoBrandSeeds(`
    <a href="/catalogo?marca-comp=fiat">FIAT</a>
    <a href="https://cymaco.com.uy/catalogo?marca-comp=renault">RENAULT</a>
    <a href="/catalogo?marca-comp=fiat">FIAT</a>
  `, 'https://cymaco.com.uy/catalogo');

  assert.deepEqual(brands, [
    { brandLabel: 'FIAT', sourceUrl: 'https://cymaco.com.uy/catalogo?marca-comp=fiat' },
    { brandLabel: 'RENAULT', sourceUrl: 'https://cymaco.com.uy/catalogo?marca-comp=renault' },
  ]);
});

test('Familcar descubre las marcas del menú principal', () => {
  const brands = extractFamilcarBrandSeeds(`
    <ul id="menu">
      <li class="hdr"><a class="tit" href="/volkswagen">Volkswagen</a></li>
      <li class="hdr"><a class="tit" href="/citroen">Citroen</a></li>
    </ul>
  `, 'https://www.familcar.com/');

  assert.deepEqual(brands, [
    { brandLabel: 'Volkswagen', sourceUrl: 'https://www.familcar.com/volkswagen' },
    { brandLabel: 'Citroen', sourceUrl: 'https://www.familcar.com/citroen' },
  ]);
});

test('Fenicio calcula cobertura, pagina y conserva la marca compatible', () => {
  const html = `
    <div class="articleList aListProductos" data-tot="12" data-totAbs="202">
      <div class="it" data-codprod="CN030037I" data-disp="1">
        <a class="img" href="/catalogo/paragolpe_CN030037I_CN030037I"><img src="/img.jpg"></a>
        <div class="info">
          <a class="tit" href="/catalogo/paragolpe_CN030037I_CN030037I" title="PARAGOLPE CITROEN">PARAGOLPE CITROEN</a>
          <div class="marca">Familcar</div>
          <strong class="precio venta"><span class="sim">$</span><span class="monto">4.090</span></strong>
        </div>
      </div>
    </div>
  `;

  assert.deepEqual(extractFenicioPageSummary(html), { pageItems: 12, totalResults: 202 });
  assert.equal(buildFenicioPageUrl('https://www.familcar.com/citroen', 17), 'https://www.familcar.com/citroen?js=1&pag=17');
  const products = extractFenicioProducts(html, 'https://www.familcar.com/citroen', 'domain', 'Citroen');
  assert.equal(products.length, 1);
  assert.equal(products[0].price, '4.090');
  assert.deepEqual(products[0].compatibleBrands, ['Citroen']);
});

test('Larrique usa una única respuesta acumulada de la última página', () => {
  const html = `
    <h2>450 productos</h2>
    <a class="productViewContainer" href="/p/bomba-bmw/969/969">
      <img src="/bomba.jpg" alt="Bomba BMW">
      <div class="productCode">SKU 511017310</div>
      <h2 class="productViewName">Bomba BMW</h2>
      <div class="productViewPrice">$ 9.954,00</div>
    </a>
  `;

  assert.equal(extractLarriqueTotalResults(html), 450);
  assert.equal(
    buildLarriqueFinalPageUrl('https://larrique.com.uy/search-by/1?searchBy%5Baux1%5D=BMW&ss=closed', 450),
    'https://larrique.com.uy/search-by/19?searchBy%5Baux1%5D=BMW&ss=closed',
  );
  const products = extractLarriqueProducts(html, 'https://larrique.com.uy/search-by/19?searchBy%5Baux1%5D=BMW&ss=closed', 'domain', 'BMW');
  assert.equal(products[0].sourceUrl, 'https://larrique.com.uy/p/bomba-bmw/969/969');
  assert.deepEqual(products[0].compatibleBrands, ['BMW']);
});

test('Larrique interpreta la respuesta de marcas sin duplicados', () => {
  assert.deepEqual(
    parseLarriqueBrandResponse('{"status":"ok","results":[{"name":"BMW"},{"name":"FIAT"},{"name":"BMW"}]}'),
    ['BMW', 'FIAT'],
  );
});

test('Yaguarón, Italur y Mirvic admiten catálogo, paginación y fichas de producto', () => {
  for (const baseUrl of [
    'https://www.yaguaron.com.uy/',
    'https://www.italur.com/',
    'https://mirvic.com.uy/',
  ]) {
    assert.equal(isAdmittedHouseUrl(baseUrl), true);
    const rule = findDomainRule(baseUrl);
    assert.ok(rule);

    const links = extractCandidateLinks(`
      <a href="/producto/filtro-aceite">Filtro de aceite - $ 450 - Comprar</a>
      <a href="/product-category/filtros/page/2/">Siguiente</a>
      <a href="/carrito/">Carrito</a>
    `, baseUrl, rule);
    assert.deepEqual(links.productLinks, [new URL('/producto/filtro-aceite', baseUrl).toString()]);
    assert.deepEqual(links.categoryLinks, [new URL('/product-category/filtros/page/2/', baseUrl).toString()]);

    const products = extractProductsFromHtml(`
      <main class="product">
        <h1 class="product_title">Filtro de aceite</h1>
        <span class="sku">SKU: FO-123</span>
        <p class="price">$ 450</p>
        <button>Agregar al carrito</button>
        <figure><img src="/images/filtro.jpg"></figure>
      </main>
    `, new URL('/producto/filtro-aceite', baseUrl).toString(), 'domain', rule);
    assert.equal(products[0]?.productName, 'Filtro de aceite');
    assert.equal(products[0]?.price, '450');
    assert.equal(products[0]?.sku, 'FO-123');
  }
});
