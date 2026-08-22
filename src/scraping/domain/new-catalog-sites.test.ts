import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildFenicioPageUrl,
  buildCatalogSitemapUrls,
  buildLarriqueFinalPageUrl,
  buildShopifyProductsUrl,
  extractCymacoBrandSeeds,
  extractFamilcarBrandSeeds,
  extractFenicioPageSummary,
  extractFenicioProducts,
  extractLarriqueProducts,
  extractLarriqueTotalResults,
  extractShopifyProducts,
  extractSitemapLocations,
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
  const imageUrl = 'https://f.fcdn.app/imgs/9f5e2b/www.familcar.com/famiuy/ccc4/original/catalogo/CN030037I_CN030037I_1/1024-1024/paragolpe-paragolpe.jpg';
  const logoUrl = 'https://f.fcdn.app/imgs/d69b00/www.familcar.com/famiuy/d1ad/original/marcas/citroen/0x0/citroen';
  const html = `
    <div class="articleList aListProductos" data-tot="12" data-totAbs="202">
      <div class="it" data-codprod="CN030037I" data-disp="1">
        <a class="img" href="/catalogo/paragolpe_CN030037I_CN030037I">
          <div class="logoMarca"><img src="${logoUrl}" alt="Citroen"></div>
          <img src="/catalogo/CN030037I_CN030037I_1/480_480/paragolpe-paragolpe.jpg">
        </a>
        <div class="info">
          <a class="tit" href="/catalogo/paragolpe_CN030037I_CN030037I" title="PARAGOLPE CITROEN">PARAGOLPE CITROEN</a>
          <div class="marca">Familcar</div>
          <strong class="precio venta"><span class="sim">$</span><span class="monto">4.090</span></strong>
        </div>
        <input type="hidden" class="json" value="{&quot;variante&quot;:{&quot;img&quot;:{&quot;u&quot;:&quot;${imageUrl}&quot;}}}">
      </div>
    </div>
  `;

  assert.deepEqual(extractFenicioPageSummary(html), { pageItems: 12, totalResults: 202 });
  assert.equal(buildFenicioPageUrl('https://www.familcar.com/citroen', 17), 'https://www.familcar.com/citroen?js=1&pag=17');
  const products = extractFenicioProducts(html, 'https://www.familcar.com/citroen', 'domain', 'Citroen');
  assert.equal(products.length, 1);
  assert.equal(products[0].price, '4.090');
  assert.equal(products[0].imageUrl, imageUrl);
  assert.equal(products[0].imageUrls?.includes(logoUrl), false);
  assert.deepEqual(products[0].compatibleBrands, ['Citroen']);
});

test('Familcar detalle Fenicio prioriza og:image y no toma el logo del header', () => {
  const rule = findDomainRule('https://www.familcar.com/catalogo/tapa-de-cilindros_P160031I_P160031I');
  assert.ok(rule);

  const productImage = 'https://f.fcdn.app/imgs/f10f47/www.familcar.com/famiuy/ccc4/original/catalogo/P160031I_P160031I_1/800x800/tapa-de-cilindros-tapa-de-cilindros.jpg';
  const logoImage = 'https://f.fcdn.app/assets/commerce/www.familcar.com/2b0b_5087/public/web/img/logo.svg';
  const products = extractProductsFromHtml(`
    <html>
      <head><meta property="og:image" content="${productImage}"></head>
      <body id="pgCatalogoDetalle">
        <header><img src="${logoImage}" alt="Familcar"></header>
        <main>
          <h1>TAPA DE CILINDROS</h1>
          <strong class="precio venta"><span class="sim">$</span><span class="monto">15.590</span></strong>
          <input type="hidden" class="json" value="{&quot;variante&quot;:{&quot;img&quot;:{&quot;u&quot;:&quot;${productImage}&quot;}}}">
        </main>
      </body>
    </html>
  `, 'https://www.familcar.com/catalogo/tapa-de-cilindros_P160031I_P160031I', 'domain', rule);

  assert.equal(products[0].imageUrl, productImage);
  assert.equal(products[0].imageUrls?.includes(logoImage), false);
});

test('Cymaco detalle Fenicio rechaza logos, cocardas e iconos antes de la imagen real', () => {
  const rule = findDomainRule('https://cymaco.com.uy/catalogo/amortiguador-fiat-del-uno_5810_001');
  assert.ok(rule);

  const productImage = 'https://f.fcdn.app/imgs/e89af5/cymaco.com.uy/cymuy/858e/original/catalogo/5810/460x460/amortiguador-fiat-del-uno.jpg';
  const logoImage = 'https://f.fcdn.app/assets/commerce/cymaco.com.uy/4a4e_23c6/public/web/img/logo.svg';
  const cocardaImage = 'https://f.fcdn.app/imgs/a49ca7/cymaco.com.uy/cymuy/4b73/original/grupoproductos/1808/100-100/cocarda.svg';
  const products = extractProductsFromHtml(`
    <html>
      <head><meta property="og:image" content="${productImage}"></head>
      <body id="pgCatalogoDetalle">
        <header><img src="${logoImage}" alt="Cymaco"></header>
        <main>
          <h1>AMORTIGUADOR FIAT DEL. UNO</h1>
          <div class="cocardas"><img src="${cocardaImage}" alt="Nuevo"></div>
          <strong class="precio venta"><span class="sim">$</span><span class="monto">3.480</span></strong>
          <img src="${productImage}" alt="AMORTIGUADOR FIAT DEL. UNO">
        </main>
      </body>
    </html>
  `, 'https://cymaco.com.uy/catalogo/amortiguador-fiat-del-uno_5810_001', 'domain', rule);

  assert.equal(products[0].imageUrl, productImage);
  assert.deepEqual(products[0].imageUrls, [productImage]);
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

test('Italur y Mirvic conservan la admisión previa', () => {
  for (const baseUrl of [
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

test('interpreta índices sitemap para los adaptadores previos', () => {
  assert.deepEqual(buildCatalogSitemapUrls('https://www.italur.com/tienda/'), [
    'https://www.italur.com/wp-sitemap.xml',
    'https://www.italur.com/sitemap_index.xml',
    'https://www.italur.com/sitemap.xml',
  ]);

  assert.deepEqual(extractSitemapLocations(`
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://www.italur.com/producto/filtro-aceite?motor=1&amp;marca=2</loc></url>
      <url><loc>https://www.italur.com/producto/pastillas-freno</loc></url>
      <url><loc>https://www.italur.com/producto/pastillas-freno</loc></url>
    </urlset>
  `, 'https://www.italur.com/'), [
    'https://www.italur.com/producto/filtro-aceite?motor=1&marca=2',
    'https://www.italur.com/producto/pastillas-freno',
  ]);
});
