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
} from './yaguaron';

const fixture = (name: string) => readFileSync(`src/scraping/domain/fixtures/yaguaron/${name}`, 'utf8');
const productUrl = 'https://www.yaguaron.com.uy/catalogo/kit-de-distribucion-tensor-y-correa-varios-modelos_123251_123251';

test('Yaguarón reconoce IDs iguales o diferentes y rechaza rutas WooCommerce', () => {
  assert.equal(isYaguaronProductUrl(productUrl), true);
  assert.equal(isYaguaronProductUrl('https://www.yaguaron.com.uy/catalogo/soporte-de-motor_111111_222222'), true);
  assert.equal(isYaguaronProductUrl('https://www.yaguaron.com.uy/producto/soporte-de-motor'), false);
  assert.equal(isYaguaronProductUrl('https://www.yaguaron.com.uy/catalogo/soporte-de-motor_111111'), false);
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
  assert.equal(product.imageUrl, 'https://www.yaguaron.com.uy/imagenes/productos/123251-grande.jpg');
  assert.deepEqual(product.imageUrls, [
    'https://www.yaguaron.com.uy/imagenes/productos/123251-grande.jpg',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-detalle.jpg',
  ]);
  assert.equal(product.imageUrls?.some((url) => /\/recursos\/|topbar|ayala-ecommerce|logo|banner|placeholder|relacionado|footer|header/i.test(url)), false);
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
  assert.deepEqual(product.imageUrls, [
    'https://www.yaguaron.com.uy/imagenes/productos/123251-principal.jpg',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-extra.jpg',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-zoom.jpg',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-galeria.webp',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-thumb.jpg',
    'https://www.yaguaron.com.uy/imagenes/productos/123251-visible.jpg',
  ]);
  assert.equal(product.imageUrls?.some((url) => /\/recursos\/|topbar|ayala-ecommerce|logo|banner|placeholder|relacionado|999999|footer|header/i.test(url)), false);
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
