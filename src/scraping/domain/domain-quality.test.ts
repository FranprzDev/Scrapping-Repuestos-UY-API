import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { findDomainRule } from './domain-rules';
import { extractProductsFromHtml } from './domain-html';
import { dedupeProducts, isSellableProduct, qualityGate } from './product-quality';

test('descarta productos agotados en cards tipo Chaparei', () => {
  const rule = findDomainRule('https://www.chaparei.com/productos/?m=171');
  assert.ok(rule);

  const html = `
    <article>
      <div>Agotado</div>
      <a href="/catalogo/carroceria/espolon-f0103280/">ESPOLON</a>
      <div>$U 5.261</div>
      <button>Consultar</button>
    </article>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.chaparei.com/productos/?m=171', 'domain', rule), rule);
  assert.equal(products.length, 0);
});

test('acepta productos con carrito en detalle tipo Taxitor', () => {
  const rule = findDomainRule('https://taxitor.uy/articulos/mostrar/1319');
  assert.ok(rule);

  const html = `
    <main>
      <h1>ABRAZADERA METALICA</h1>
      <p>$ 39.74</p>
      <button>Agregar al carrito</button>
    </main>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://taxitor.uy/articulos/mostrar/1319', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'ABRAZADERA METALICA');
  assert.equal(isSellableProduct(products[0], rule), true);
});

test('acepta detalle de Chaparei con boton comprar y agotado oculto', () => {
  const detailUrl = 'https://www.chaparei.com/catalogo/accesorios-y-paragolpes/paragolpe-demo-b2200381/';
  const rule = findDomainRule(detailUrl);
  assert.ok(rule);

  const html = `
    <main>
      <h1>PARAGOLPE DELANTERO C/PRIMER 91/93</h1>
      <h2 class="copete_ficha">BMW - CARROCERIA E-36 SERIE 325i 1990-97</h2>
      <div class="precios_cont">
        <div class="precio_cont_mas" itemprop="offers">
          <span class="ele">
            <span class="moneda">$U</span>
            <span class="entero" itemprop="price" content="3.894">3.894</span>
            <span class="imp">IVA inc.</span>
          </span>
        </div>
        <div class="opcionescarrito">
          <div class="opciones_cart">
            <div style="display:none" id="producto_agotado" class="agotado"><span>Agotado</span></div>
            <div class="submit"><button type="submit"><span>Comprar</span></button></div>
          </div>
        </div>
      </div>
    </main>
  `;

  const products = qualityGate(extractProductsFromHtml(html, detailUrl, 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].price, '3.894');
  assert.equal(products[0].availability, 'in_stock');
});

test('rechaza productos con precio cero aunque tengan stock positivo', () => {
  const rule = findDomainRule('https://www.chaparei.com/catalogo/demo/');
  assert.ok(rule);

  const products = qualityGate([
    {
      productName: 'PARAGOLPE DEMO',
      price: '0,00',
      stock: '5',
      availability: 'in_stock',
      sourceUrl: 'https://www.chaparei.com/catalogo/demo/',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
  ], rule);

  assert.equal(products.length, 0);
});

test('acepta productos JSON-LD con disponibilidad positiva', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/product/demo/');
  assert.ok(rule);

  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "BROCHE DEMO",
            "sku": "SKU123",
            "url": "https://www.selvir.com.uy/product/demo/",
            "offers": {
              "price": "404",
              "priceCurrency": "UYU",
              "availability": "https://schema.org/InStock"
            }
          }
        </script>
      </head>
      <body><h1>BROCHE DEMO</h1></body>
    </html>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.selvir.com.uy/product/demo/', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].sku, 'SKU123');
});

test('rechaza paginas 404 aunque tengan texto y precio', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/product/rejilla-falsa/');
  assert.ok(rule);

  const html = `
    <main>
      <h1>¡Vaya! No se ha podido encontrar esa página.</h1>
      <div>404</div>
      <div>$404</div>
    </main>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.selvir.com.uy/product/rejilla-falsa/', 'domain', rule), rule);
  assert.equal(products.length, 0);
});

test('deduplica por sourceUrl y sku sin perder datos utiles', () => {
  const products = dedupeProducts([
    {
      productName: 'Demo',
      price: '100',
      sourceUrl: 'https://example.com/p/1',
      sku: 'SKU1',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
    {
      productName: 'Demo',
      price: '100',
      sourceUrl: 'https://example.com/p/1',
      sku: 'SKU1',
      description: 'Detalle',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
  ]);

  assert.equal(products.length, 1);
  assert.equal(products[0].description, 'Detalle');
});
