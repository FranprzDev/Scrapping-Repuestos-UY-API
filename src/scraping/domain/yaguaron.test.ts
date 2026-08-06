import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalizeYaguaronProductUrl,
  dedupeYaguaronProducts,
  extractYaguaronCategoryUrls,
  extractYaguaronArticlePosition,
  extractYaguaronDeclaredTotal,
  extractYaguaronDetail,
  extractYaguaronListingSummary,
  extractYaguaronProductUrls,
  isYaguaronProductUrl,
  LOGO_IMAGE_PATTERN,
  normalizeYaguaronPrice,
  NON_PRODUCT_IMAGE_PATTERN,
} from './yaguaron';
import { addYaguaronListingProducts } from './yaguaron-pagination';

const fixture = (name: string) => readFileSync(`src/scraping/domain/fixtures/yaguaron/${name}`, 'utf8');
const productUrl = 'https://www.yaguaron.com.uy/catalogo/kit-de-distribucion-tensor-y-correa-varios-modelos_123251_123251';
const variantImageUrl = 'https://f.fcdn.app/abc/catalogo/123251_123251_1/1024-1024/producto.jpg';
const realProductImageUrl = 'https://f.fcdn.app/imgs/2e83d7/www.yaguaron.com.uy/yaguuy/3bb6/original/catalogo/123251_123251_1/800x800/kit-de-distribucion-tensor-y-correa-varios-modelos-kit-de-distribucion-tensor-y-correa-varios-modelos.jpg';
const isRejectedImageForTest = (url: string) => NON_PRODUCT_IMAGE_PATTERN.test(url) || LOGO_IMAGE_PATTERN.test(new URL(url).pathname);

test('Yaguarón reconoce IDs iguales o diferentes y rechaza rutas WooCommerce', () => {
  assert.equal(isYaguaronProductUrl(productUrl), true);
  assert.equal(isYaguaronProductUrl('https://www.yaguaron.com.uy/catalogo/soporte-de-motor_111111_222222'), true);
  assert.equal(isYaguaronProductUrl('https://www.yaguaron.com.uy/producto/soporte-de-motor'), false);
  assert.equal(isYaguaronProductUrl('https://www.yaguaron.com.uy/catalogo/soporte-de-motor_111111'), false);
});

test('Yaguarón no rechaza imágenes de catálogo por contener logo dentro de catalogo', () => {
  const catalogImage = 'https://f.fcdn.app/abc/catalogo/123251/producto.jpg';
  const logoImage = 'https://www.yaguaron.com.uy/imagenes/logo-principal.png';

  assert.equal(NON_PRODUCT_IMAGE_PATTERN.test(catalogImage), false);
  assert.equal(LOGO_IMAGE_PATTERN.test(new URL(catalogImage).pathname), false);
  assert.equal(LOGO_IMAGE_PATTERN.test(new URL(logoImage).pathname), true);
});

test('Yaguarón descubre categorías, productos y total declarado del listado Fenicio', () => {
  const html = fixture('listing.html');
  assert.deepEqual(extractYaguaronCategoryUrls(html, 'https://www.yaguaron.com.uy/'), [
    'https://www.yaguaron.com.uy/motor-y-componentes',
    'https://www.yaguaron.com.uy/celta/motor-y-componentes/motor',
  ]);
  assert.deepEqual(extractYaguaronListingSummary(html), { pageItems: 2, declaredTotal: 437 });
  assert.equal(extractYaguaronProductUrls(html, 'https://www.yaguaron.com.uy/').length, 2);
  assert.equal(extractYaguaronProductUrls(fixture('listing-page-2.ajax.html'), 'https://www.yaguaron.com.uy/')[0], 'https://www.yaguaron.com.uy/catalogo/soporte-de-motor_111111_222222');
});

test('Yaguarón pagina una categoría aunque sus primeros productos ya existan globalmente', () => {
  const globalProducts = new Set<string>();
  const categoryA = new Set<string>();
  const categoryB = new Set<string>();
  const productUrlFor = (id: number) => `https://www.yaguaron.com.uy/catalogo/producto-${id}_${id}_${id}`;
  const firstPage = Array.from({ length: 12 }, (_, index) => productUrlFor(index + 1));
  const secondPage = Array.from({ length: 12 }, (_, index) => productUrlFor(index + 13));

  const categoryAProgress = addYaguaronListingProducts(firstPage, categoryA, globalProducts, 12);
  assert.equal(categoryAProgress.reachedDeclaredTotal, true);
  assert.equal(globalProducts.size, 12);

  const categoryBFirstPage = addYaguaronListingProducts(firstPage, categoryB, globalProducts, 24);
  assert.equal(categoryBFirstPage.newInListing, 12);
  assert.equal(categoryBFirstPage.noNewInThisListing, false);
  assert.equal(categoryBFirstPage.reachedDeclaredTotal, false);
  assert.equal(globalProducts.size, 12);

  const categoryBSecondPage = addYaguaronListingProducts(secondPage, categoryB, globalProducts, 24);
  assert.equal(categoryBSecondPage.newInListing, 12);
  assert.equal(categoryBSecondPage.uniqueInListing, 24);
  assert.equal(categoryBSecondPage.reachedDeclaredTotal, true);
  assert.equal(globalProducts.size, 24);
});

test('Yaguarón controla declaredTotal con el total local del listing, no con el global', () => {
  const globalProducts = new Set<string>(
    Array.from({ length: 30 }, (_, index) => `https://www.yaguaron.com.uy/catalogo/global-${index + 1}_${index + 1}_${index + 1}`),
  );
  const listingProducts = new Set<string>();
  const found = Array.from({ length: 12 }, (_, index) => `https://www.yaguaron.com.uy/catalogo/local-${index + 1}_${index + 1}_${index + 1}`);

  const progress = addYaguaronListingProducts(found, listingProducts, globalProducts, 24);

  assert.equal(progress.uniqueInListing, 12);
  assert.equal(progress.reachedDeclaredTotal, false);
  assert.equal(globalProducts.size, 42);
});

test('Yaguarón excluye páginas informativas sin bloquear modelos ni categorías reales', () => {
  const html = `
    <nav class="menu">
      <a href="/nosotros">Nosotros</a>
      <a href="/salir">Salir</a>
      <a href="/tiendas">Tiendas</a>
      <a href="/terminos-condiciones">Términos</a>
      <a href="/trabaja-con-nosotros">Trabaja con nosotros</a>
      <a href="/como-comprar">Cómo comprar</a>
      <a href="/condiciones-de-compra">Condiciones</a>
      <a href="/envios-devoluciones">Envíos</a>
      <a href="/preguntas-frecuentes">Preguntas</a>
      <a href="/agile">Agile</a>
      <a href="/corsa">Corsa</a>
      <a href="/onix">Onix</a>
      <a href="/motor-y-componentes">Motor y componentes</a>
    </nav>
  `;

  assert.deepEqual(extractYaguaronCategoryUrls(html, 'https://www.yaguaron.com.uy/'), [
    'https://www.yaguaron.com.uy/agile',
    'https://www.yaguaron.com.uy/corsa',
    'https://www.yaguaron.com.uy/onix',
    'https://www.yaguaron.com.uy/motor-y-componentes',
  ]);
});

test('Yaguarón extrae la ficha real 123251 sin tomar sku.fen ni contenedores amplios', () => {
  const html = fixture('detail-123251.html');
  const product = extractYaguaronDetail(`${html}<img src="/banner-home.jpg">`, `${productUrl}?utm_source=test#comprar`, 'domain');
  assert.ok(product);
  assert.equal(product.productName, 'KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS');
  assert.equal(product.sku, '123251');
  assert.equal(product.price, '1643');
  assert.equal(product.currency, 'UYU');
  assert.deepEqual(product.attributes, {
    calidad: 'ORIGINAL',
    fabricante: 'ORIGINAL GM / AC DELCO',
    referencias: '90531677 / 93353848',
    caracteristicas: 'Modelo: Agile, Celta, Corsa, Montana, Onix, Prisma',
  });
  assert.equal(product.description, 'Kit original de tensor y correa para los modelos indicados.');
  assert.doesNotMatch(product.description ?? '', /env[ií]os|medios de pago|cambios|devoluciones|redes sociales|productos relacionados|precioMonto|producto/i);
  assert.equal(product.imageUrl, realProductImageUrl);
  assert.ok(product.imageUrls);
  assert.equal(product.imageUrls.includes(realProductImageUrl), true);
  assert.equal(product.imageUrls.every((url) => url.includes('/catalogo/123251_123251_1/')), true);
  assert.equal(product.imageUrls.some(isRejectedImageForTest), false);
  assert.equal(product.imageUrls.some((url) => /topbar|ayala-ecommerce|relacionad|logoMarca|medios[-_]?pago|visa/i.test(url)), false);
  assert.equal(product.availability, 'in_stock');
  assert.equal(product.sourceUrl, productUrl);
  assert.deepEqual(product.compatibleModels, ['Agile', 'Celta', 'Corsa', 'Montana', 'Onix', 'Prisma']);
  assert.deepEqual(extractYaguaronArticlePosition(html), { current: 1, total: 437 });
  assert.equal(extractYaguaronDeclaredTotal(html), undefined);
});

test('Yaguarón prioriza producto.img del SKU actual y conserva galería visible sin imágenes ajenas', () => {
  const product = extractYaguaronDetail(`
    <main class="aFichaProducto">
      <h1>KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS</h1>
      <div class="precio venta">$ 1.643</div><button>COMPRAR</button>
      <img src="https://f.fcdn.app/123/recursos/129/1920x50/ayala-ecommerceyaguaron-topbar-1.jpg">
      <header><img src="/imagenes/logo-yaguaron.png"></header>
      <section class="blkCaracteristicas"><div class="it"><span class="tit">Art.</span><span class="val">123251</span></div></section>
      <div class="imagenes">
        <img src="https://f.fcdn.app/123/recursos/129/1920x50/ayala-ecommerceyaguaron-topbar-1.jpg">
        <a href="/imagenes/productos/123251-visible.jpg"><img src="/imagenes/productos/123251-thumb.jpg" data-zoom-image="/imagenes/productos/123251-zoom.jpg"></a>
        <img data-src="/imagenes/productos/123251-galeria.webp">
        <img src="/imagenes/logo-yaguaron.png">
        <img src="/imagenes/banner-home.jpg">
        <img src="/imagenes/placeholder.png">
      </div>
      <section class="productosRelacionados"><img src="/imagenes/productos/relacionado.jpg"></section>
      <script type="application/json">{"producto":{"codigo":"999999","nombre":"OTRO PRODUCTO","img":"/imagenes/productos/999999-ajeno.jpg"},"precioMonto":999,"moneda":{"cod":"UYU"},"tieneStock":true}</script>
      <script type="application/json">{"producto":{"codigo":"123251","nombre":"KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS","img":{"principal":"%2Fimagenes%2Fproductos%2F123251-principal.jpg"},"imagenes":[{"url":"\/imagenes\/productos\/123251-extra.jpg"}]},"precioMonto":1643,"moneda":{"cod":"UYU"},"tieneStock":true}</script>
    </main>
  `, productUrl, 'domain');

  assert.ok(product);
  assert.equal(product.imageUrl, 'https://www.yaguaron.com.uy/imagenes/productos/123251-principal.jpg');
  assert.ok(product.imageUrls);
  const [mainImage, ...secondaryImages] = product.imageUrls;
  assert.equal(mainImage, 'https://www.yaguaron.com.uy/imagenes/productos/123251-principal.jpg');
  assert.deepEqual(new Set(secondaryImages), new Set([
    'https://www.yaguaron.com.uy/imagenes/productos/123251-extra.jpg',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-zoom.jpg',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-galeria.webp',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-thumb.jpg',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-visible.jpg',
  ]));
  assert.equal(product.imageUrls.some(isRejectedImageForTest), false);
});

test('Yaguarón extrae la imagen real desde variantes.img aunque producto no tenga img', () => {
  const product = extractYaguaronDetail(`
    <main class="aFichaProducto">
      <h1>KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS</h1>
      <div class="precio venta">$ 1.643</div><button>COMPRAR</button>
      <section class="blkCaracteristicas"><div class="it"><span class="tit">Art.</span><span class="val">123251</span></div></section>
      <script type="application/json">{"producto":{"codigo":"123251","nombre":"KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS"},"variantes":{"codigo":"123251","codigoCompleto":"123251123251","img":"//f.fcdn.app/abc/catalogo/123251_123251_1/1024-1024/producto.jpg"},"precioMonto":1643,"moneda":{"cod":"UYU"},"tieneStock":true}</script>
    </main>
  `, productUrl, 'domain');

  assert.ok(product);
  assert.equal(product.imageUrl, variantImageUrl);
  assert.deepEqual(product.imageUrls, [variantImageUrl]);
});

test('Yaguarón no transforma códigos de variante en URLs de imagen', () => {
  const expected = 'https://f.fcdn.app/catalogo/123251/producto.jpg';
  const product = extractYaguaronDetail(`
    <main class="aFichaProducto">
      <h1>PRODUCTO</h1>
      <div class="precio venta">$ 1.643</div><button>COMPRAR</button>
      <section class="blkCaracteristicas"><div class="it"><span class="tit">Art.</span><span class="val">123251</span></div></section>
      <script type="application/json">{"producto":{"codigo":"123251","nombre":"PRODUCTO"},"variante":{"codigo":"123251","codigoCompleto":"123251123251","nombre":"PRODUCTO","url":"/catalogo/123251","tieneStock":true,"ordenVariante":1,"img":{"u":"//f.fcdn.app/catalogo/123251/producto.jpg"}},"precioMonto":1643,"moneda":{"cod":"UYU"},"tieneStock":true}</script>
    </main>
  `, productUrl, 'domain');

  assert.ok(product);
  assert.deepEqual(product.imageUrls, [expected]);
  assert.equal(product.imageUrls?.includes('https://www.yaguaron.com.uy/catalogo/123251'), false);
  assert.equal(product.imageUrls?.includes('https://www.yaguaron.com.uy/catalogo/123251123251'), false);
});

test('Yaguarón prefiere el JSON completo con variantes.img frente al objeto corto del mismo SKU', () => {
  const completeVariantUrl = 'https://f.fcdn.app/catalogo/123251_123251_1/producto.jpg';
  const product = extractYaguaronDetail(`
    <main class="aFichaProducto">
      <h1>KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS</h1>
      <div class="precio venta">$ 1.643</div><button>COMPRAR</button>
      <section class="blkCaracteristicas"><div class="it"><span class="tit">Art.</span><span class="val">123251</span></div></section>
      <script type="application/json">{"producto":{"codigo":"123251"},"precioMonto":1643}</script>
      <script type="application/json">{"producto":{"codigo":"123251"},"variantes":{"codigo":"123251","img":"//f.fcdn.app/catalogo/123251_123251_1/producto.jpg"},"precioMonto":1643}</script>
    </main>
  `, productUrl, 'domain');

  assert.ok(product);
  assert.equal(product.imageUrl, completeVariantUrl);
  assert.deepEqual(product.imageUrls, [completeVariantUrl]);
});

test('Yaguarón conserva sólo variantes.img frente a topbar y productos relacionados', () => {
  const product = extractYaguaronDetail(`
    <main class="aFichaProducto">
      <h1>KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS</h1>
      <div class="precio venta">$ 1.643</div><button>COMPRAR</button>
      <section class="blkCaracteristicas"><div class="it"><span class="tit">Art.</span><span class="val">123251</span></div></section>
      <div class="imagenes"><img src="https://f.fcdn.app/123/recursos/129/1920x50/ayala-ecommerceyaguaron-topbar-1.jpg"></div>
      <section class="productosRelacionados"><img src="/imagenes/productos/relacionado.jpg"></section>
      <script type="application/json">{"producto":{"codigo":"123251","nombre":"KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS"},"variantes":{"codigo":"123251","codigoCompleto":"123251123251","img":"//f.fcdn.app/abc/catalogo/123251_123251_1/1024-1024/producto.jpg"},"precioMonto":1643,"moneda":{"cod":"UYU"},"tieneStock":true}</script>
    </main>
  `, productUrl, 'domain');

  assert.ok(product);
  assert.equal(product.imageUrl, variantImageUrl);
  assert.deepEqual(product.imageUrls, [variantImageUrl]);
  assert.equal(product.imageUrls.some(isRejectedImageForTest), false);
});

test('Yaguarón rechaza el banner topbar de recursos aunque aparezca en el área de imágenes', () => {
  const product = extractYaguaronDetail(`
    <main class="aFichaProducto">
      <h1>KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS</h1>
      <div class="precio venta">$ 1.643</div><button>COMPRAR</button>
      <section class="blkCaracteristicas"><div class="it"><span class="tit">Art.</span><span class="val">123251</span></div></section>
      <div class="imagenes">
        <img src="https://f.fcdn.app/123/recursos/129/1920x50/ayala-ecommerceyaguaron-topbar-1.jpg">
      </div>
    </main>
  `, productUrl, 'domain');

  assert.ok(product);
  assert.equal(product.imageUrl, undefined);
  assert.equal(product.imageUrls, undefined);
});

test('Yaguarón extrae referencias cuando sólo aparecen dentro de la descripción', () => {
  const product = extractYaguaronDetail(`
    <main class="aFichaProducto">
      <h1>KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS</h1>
      <div class="precio venta">$ 1.643</div><button>COMPRAR</button>
      <section class="blkCaracteristicas">
        <div class="it"><span class="tit">Art.</span><span class="val">123251</span></div>
        <div class="it"><span class="tit">Calidad</span><span class="val">ORIGINAL</span></div>
        <div class="it"><span class="tit">Fabricante</span><span class="val">ORIGINAL GM / AC DELCO</span></div>
        <div class="it"><span class="tit">Modelo</span><span class="val">Agile, Celta, Corsa, Montana, Onix, Prisma</span></div>
      </section>
      <section class="descripcion">Calidad: ORIGINAL Fabricante: ORIGINAL GM / AC DELCO Referencia: 90531677 / 93353848</section>
    </main>
  `, productUrl, 'domain');

  assert.ok(product);
  assert.equal(product.attributes?.referencias, '90531677 / 93353848');
  assert.deepEqual(product.attributes, {
    calidad: 'ORIGINAL',
    fabricante: 'ORIGINAL GM / AC DELCO',
    referencias: '90531677 / 93353848',
    caracteristicas: 'Modelo: Agile, Celta, Corsa, Montana, Onix, Prisma',
  });
});

test('Yaguarón usa la descripción si una referencia visible ruidosa es rechazada', () => {
  const product = extractYaguaronDetail(`
    <main class="aFichaProducto">
      <h1>KIT DE DISTRIBUCIÓN TENSOR Y CORREA - VARIOS MODELOS</h1>
      <div class="precio venta">$ 1.643</div><button>COMPRAR</button>
      <section class="blkCaracteristicas">
        <div class="it"><span class="tit">Art.</span><span class="val">123251</span></div>
        <div class="it"><span class="tit">Calidad</span><span class="val">ORIGINAL</span></div>
        <div class="it"><span class="tit">Fabricante</span><span class="val">ORIGINAL GM / AC DELCO</span></div>
        <div class="it"><span class="tit">Referencias</span><span class="val">Inicio Catálogo Envíos medios de pago redes sociales</span></div>
        <div class="it"><span class="tit">Modelo</span><span class="val">Agile, Celta, Corsa, Montana, Onix, Prisma</span></div>
      </section>
      <section class="descripcion">Calidad: ORIGINAL Fabricante: ORIGINAL GM / AC DELCO Referencia: 90531677 / 93353848</section>
    </main>
  `, productUrl, 'domain');

  assert.ok(product);
  assert.equal(product.attributes?.referencias, '90531677 / 93353848');
});

test('Yaguarón conserva una ficha agotada', () => {
  const url = 'https://www.yaguaron.com.uy/catalogo/farol-trasero-izquierdo-fume-prisma-ltz_135595_135595';
  const product = extractYaguaronDetail(fixture('detail-135595.html'), url, 'domain');
  assert.equal(product?.availability, 'out_of_stock');
  assert.equal(product?.sku, '135595');
  assert.equal(product?.imageUrl, 'https://www.yaguaron.com.uy/imagenes/productos/135595.jpg');
});

test('Yaguarón canonicaliza la ficha eliminando query y fragmento', () => {
  assert.equal(canonicalizeYaguaronProductUrl(`${productUrl}/?marca=gm#detalle`), productUrl);
});

test('Yaguarón deduplica primero por URL canónica y también por Art./SKU', () => {
  const first = extractYaguaronDetail(fixture('detail-123251.html'), productUrl, 'domain');
  assert.ok(first);
  const result = dedupeYaguaronProducts([
    first,
    { ...first, sourceUrl: `${productUrl}?utm_source=duplicate` },
    { ...first, sourceUrl: 'https://www.yaguaron.com.uy/catalogo/kit-alternativo_999999_999999' },
  ]);
  assert.equal(result.products.length, 1);
  assert.equal(result.duplicates, 2);
});

test('Yaguaron normalizes Uruguayan price formatting', () => {
  assert.equal(normalizeYaguaronPrice('1.701'), '1701');
  assert.equal(normalizeYaguaronPrice('3.321'), '3321');
  assert.equal(normalizeYaguaronPrice('5.114'), '5114');
  assert.equal(normalizeYaguaronPrice('968'), '968');
  assert.equal(normalizeYaguaronPrice('1.701,50'), '1701.50');
  assert.equal(normalizeYaguaronPrice('12.345,67'), '12345.67');
  assert.equal(normalizeYaguaronPrice('$U 1.701'), '1701');
  assert.equal(normalizeYaguaronPrice('UYU 1.701,50'), '1701.50');
});

test('Yaguaron keeps SKU 168662 detail fields while storing 1.701 as 1701', () => {
  const url = 'https://www.yaguaron.com.uy/catalogo/juego-4-tazas-rueda-15-8-rayos-agile-montana_168662_168662';
  const imageUrl = 'https://www.yaguaron.com.uy/imagenes/productos/168662.jpg';
  const product = extractYaguaronDetail(`
    <main class="aFichaProducto">
      <h1>JUEGO 4 TAZAS RUEDA 15 8 RAYOS - AGILE / MONTANA</h1>
      <div class="precio venta">$U 1.701</div><button>COMPRAR</button>
      <section class="blkCaracteristicas">
        <div class="it"><span class="tit">Art.</span><span class="val">168662</span></div>
        <div class="it"><span class="tit">Modelo</span><span class="val">Agile, Montana</span></div>
      </section>
      <div class="imagenes"><img src="/imagenes/productos/168662.jpg"></div>
      <script type="application/json">{"producto":{"codigo":"168662","nombre":"JUEGO 4 TAZAS RUEDA 15 8 RAYOS - AGILE / MONTANA"},"precioMonto":"1.701","moneda":{"cod":"UYU"},"tieneStock":true}</script>
    </main>
  `, url, 'domain');

  assert.ok(product);
  assert.equal(product.price, '1701');
  assert.notEqual(product.price, '1.701');
  assert.notEqual(Math.round(Number(product.price)), 2);
  assert.equal(product.sku, '168662');
  assert.equal(product.productName, 'JUEGO 4 TAZAS RUEDA 15 8 RAYOS - AGILE / MONTANA');
  assert.equal(product.imageUrl, imageUrl);
  assert.deepEqual(product.imageUrls, [imageUrl]);
  assert.deepEqual(product.compatibleModels, ['Agile', 'Montana']);
  assert.equal(product.availability, 'in_stock');
  assert.equal(product.sourceUrl, url);
});
