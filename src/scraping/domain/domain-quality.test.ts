import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { findDomainRule } from './domain-rules';
import { extractCandidateLinks, extractProductsFromHtml } from './domain-html';
import { countQualityWarnings, dedupeProducts, isAllowedCatalogUrl, isSellableProduct, qualityGate } from './product-quality';

test('preserva productos agotados en cards tipo Chaparei', () => {
  const rule = findDomainRule('https://www.chaparei.com/productos/?m=171');
  assert.ok(rule);

  const html = `
    <article class="prod_item">
      <div class="foto">
        <a href="/catalogo/carroceria/espolon-original-f0104160/" target="_blank">
          <img src="https://www.chaparei.com/imgs/productos/productos31_19984.jpg" alt="ESPOLON -ORIGINAL-">
        </a>
      </div>
      <div class="cont">
        <h2><a href="/catalogo/carroceria/espolon-original-f0104160/"><span itemprop="name">ESPOLON -ORIGINAL-</span></a></h2>
        <h2 class="copete_ficha">FIAT - STRADA ULTRA 1.0cc 2024- (281DMX)</h2>
      </div>
      <div class="opcionespreciocont">
        <div class="precios">
          <div class="precio_cont" itemprop="offers">
            <span class="ele">
              <span class="pmoneda">$U</span>
              <span id="precio_ent_actual" itemprop="price" content="12.463">12.463</span>
            </span>
          </div>
        </div>
      </div>
      <div class="opcionescarrito">
        <div class="opciones_cart">
          <div style="display:none" id="producto_agotado" class="agotado"><span>Agotado</span></div>
          <div class="submit"><button type="submit"><span>Comprar</span></button></div>
        </div>
      </div>
    </article>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.chaparei.com/productos/?m=171', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'ESPOLON -ORIGINAL-');
  assert.equal(products[0].price, '12.463');
  assert.equal(products[0].sourceUrl, 'https://www.chaparei.com/catalogo/carroceria/espolon-original-f0104160/');
  assert.equal(products[0].availability, 'out_of_stock');
  assert.ok(products[0].qualityWarnings?.includes('not_sellable'));
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
  assert.equal(products[0].brand, 'BMW');
  assert.equal(products[0].availability, 'in_stock');
});

test('preserva productos con precio cero y los marca con warning', () => {
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

  assert.equal(products.length, 1);
  assert.ok(products[0].qualityWarnings?.includes('invalid_price'));
  assert.ok(products[0].qualityWarnings?.includes('not_sellable'));
});

test('preserva productos sin precio cuando el sitio expone solo el nombre', () => {
  const rule = findDomainRule('https://www.chaparei.com/productos/?m=171');
  assert.ok(rule);

  const html = `
    <article>
      <a href="/productos/productos.php?c=4488&m=171">KIT PARAGOLPE KWID</a>
      <div>Agregando detalles</div>
      <button>Comprar</button>
    </article>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.chaparei.com/productos/?m=171', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'KIT PARAGOLPE KWID');
  assert.equal(products[0].price, undefined);
  assert.ok(products[0].qualityWarnings?.includes('missing_price'));
});

test('descubre productos Chaparei por heuristica semantica aunque el href no sea exacto', () => {
  const rule = findDomainRule('https://www.chaparei.com/productos/?m=171');
  assert.ok(rule);

  const html = `
    <article>
      <a href="/detalle/ficha-123">GUARDABARRO DELT. IZQ.</a>
      <div>$U 6.149,00</div>
      <button>Comprar</button>
    </article>
  `;

  const links = extractCandidateLinks(html, 'https://www.chaparei.com/productos/?m=171', rule);
  assert.equal(links.productLinks.length, 1);
});

test('acepta enlaces del mismo host aunque cambien entre www y sin www', () => {
  assert.equal(
    isAllowedCatalogUrl('https://www.feyvi.com.uy/repuestos/acabamiento-exterior/', 'https://feyvi.com.uy/repuestos/acabamiento-exterior/'),
    true,
  );
});

test('descubre opciones de orden Chaparei desde option[value]', () => {
  const rule = findDomainRule('https://www.chaparei.com/productos/?m=171');
  assert.ok(rule);

  const html = `
    <select>
      <option value="/productos/productos.php?m=171&amp;order=2&amp;mo=1">Precio menor</option>
      <option value="/productos/productos.php?m=171&amp;order=7&amp;mo=1">Más vendidos</option>
      <option value="171">FIAT</option>
    </select>
  `;

  const links = extractCandidateLinks(html, 'https://www.chaparei.com/productos/?m=171', rule);
  assert.ok(links.categoryLinks.includes('https://www.chaparei.com/productos/productos.php?m=171&order=2&mo=1'));
  assert.ok(links.categoryLinks.includes('https://www.chaparei.com/productos/productos.php?m=171&order=7&mo=1'));
  assert.equal(links.categoryLinks.some((url) => url.endsWith('/171')), false);
});

test('extrae tarjetas reales de Chaparei sin mezclar nombre, precio y url', () => {
  const rule = findDomainRule('https://www.chaparei.com/productos/?m=171');
  assert.ok(rule);

  const html = `
    <section>
      <article class="prod_item">
        <div class="foto">
          <a href="/catalogo/carroceria/espolon-original-f0104160/" target="_blank">
            <img src="https://www.chaparei.com/imgs/productos/productos31_19984.jpg" alt="ESPOLON -ORIGINAL-">
          </a>
        </div>
        <div class="cont">
          <h2><a href="/catalogo/carroceria/espolon-original-f0104160/"><span itemprop="name">ESPOLON -ORIGINAL-</span></a></h2>
          <h2 class="copete_ficha">FIAT - STRADA ULTRA 1.0cc 2024- (281DMX)</h2>
        </div>
        <div class="precios_cont">
          <div class="precio_cont_mas" itemprop="offers">
            <div class="prod_preciomas">
              <span class="ele">
                <span class="moneda">$U</span>
                <span class="entero" itemprop="price" content="12.463">12.463</span>
              </span>
            </div>
          </div>
        </div>
      </article>
      <article class="prod_item">
        <div class="foto">
          <a href="/catalogo/carroceria/espolon-f0104180/" target="_blank">
            <img src="https://www.chaparei.com/imgs/productos/productos31_19985.jpg" alt="ESPOLON">
          </a>
        </div>
        <div class="cont">
          <h2><a href="/catalogo/carroceria/espolon-f0104180/"><span itemprop="name">ESPOLON</span></a></h2>
          <h2 class="copete_ficha">FIAT - UNO 2004-11 3 PTAS. 1.3cc FIRE (158076)</h2>
        </div>
        <div class="precios_cont">
          <div class="precio_cont_mas" itemprop="offers">
            <div class="prod_preciomas">
              <span class="ele">
                <span class="moneda">$U</span>
                <span class="entero" itemprop="price" content="5.846">5.846</span>
              </span>
            </div>
          </div>
        </div>
      </article>
    </section>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.chaparei.com/productos/?m=171', 'domain', rule), rule);
  assert.equal(products.length, 2);
  assert.deepEqual(
    products.map((product) => ({
      productName: product.productName,
      price: product.price,
      sourceUrl: product.sourceUrl,
    })),
    [
      {
        productName: 'ESPOLON -ORIGINAL-',
        price: '12.463',
        sourceUrl: 'https://www.chaparei.com/catalogo/carroceria/espolon-original-f0104160/',
      },
      {
        productName: 'ESPOLON',
        price: '5.846',
        sourceUrl: 'https://www.chaparei.com/catalogo/carroceria/espolon-f0104180/',
      },
    ],
  );
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
});

test('extrae tarjetas Selvir reales sin mezclar titulo y precio entre productos', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/product-category/carroceria/');
  assert.ok(rule);

  const html = `
    <ul class="products columns-3">
      <a href="https://www.selvir.com.uy/product/10-broches-gm-86-1y0143/">
        <div class="item col-md-4 col-sm-4 col-xs-12 item-shop">
          <div class="product-item-container post-44035 product type-product status-publish product_cat-broches product_cat-carroceria first instock shipping-taxable purchasable product-type-simple">
            <div class="product-image">
              <img src="https://www.selvir.com.uy/images/producto3.gif" alt="10 BROCHES GM 86-1Y0143">
            </div>
            <div class="product-info product-info-shop">
              <div class="product-info-title">10 BROCHES GM 86-1Y0143</div>
              <span class="product-info-price">
                <span class="woocommerce-Price-amount amount">
                  <span class="woocommerce-Price-currencySymbol">$</span>
                  <span class="woocommerce-Price-currency">153</span>
                  <span class="woocommerce-Price-SiStock">Disponible</span>
                </span>
              </span>
              <div class="cart">
                <form class="cart" action="https://www.selvir.com.uy/product/10-broches-gm-86-1y0143/">
                  <button type="submit">Comprar</button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </a>
      <a href="https://www.selvir.com.uy/product/10-broches-gm-86-1y0144/">
        <div class="item col-md-4 col-sm-4 col-xs-12 item-shop">
          <div class="product-item-container post-44034 product type-product status-publish product_cat-broches product_cat-carroceria instock shipping-taxable purchasable product-type-simple">
            <div class="product-image">
              <img src="https://www.selvir.com.uy/images/producto3.gif" alt="10 BROCHES GM 86-1Y0144">
            </div>
            <div class="product-info product-info-shop">
              <div class="product-info-title">10 BROCHES GM 86-1Y0144</div>
              <span class="product-info-price">
                <span class="woocommerce-Price-amount amount">
                  <span class="woocommerce-Price-currencySymbol">$</span>
                  <span class="woocommerce-Price-currency">182</span>
                  <span class="woocommerce-Price-SiStock">Disponible</span>
                </span>
              </span>
              <div class="cart">
                <form class="cart" action="https://www.selvir.com.uy/product/10-broches-gm-86-1y0144/">
                  <button type="submit">Comprar</button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </a>
    </ul>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.selvir.com.uy/product-category/carroceria/', 'domain', rule), rule);
  assert.equal(products.length, 2);
  assert.deepEqual(
    products.map((product) => ({
      productName: product.productName,
      price: product.price,
      sourceUrl: product.sourceUrl,
    })),
    [
      {
        productName: '10 BROCHES GM 86-1Y0143',
        price: '153',
        sourceUrl: 'https://www.selvir.com.uy/product/10-broches-gm-86-1y0143/',
      },
      {
        productName: '10 BROCHES GM 86-1Y0144',
        price: '182',
        sourceUrl: 'https://www.selvir.com.uy/product/10-broches-gm-86-1y0144/',
      },
    ],
  );
});

test.skip('limpia nombres y precios de listados Selvir', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/amortiguadores/');
  assert.ok(rule);

  const html = `
    <article>
      <a href="/product/amortiguador-del-chery-beat-13/">
        AMORTIGUADOR DEL CHERY BEAT 13 CÃ³digo 23152 $ 2.200 Disponible Comprar
      </a>
    </article>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.selvir.com.uy/amortiguadores/', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'AMORTIGUADOR DEL CHERY BEAT 13');
  assert.equal(products[0].price, '2.200');
  assert.equal(products[0].sourceUrl, 'https://www.selvir.com.uy/product/amortiguador-del-chery-beat-13/');
});

test('extrae el precio correcto del detalle Selvir y no toma relacionados', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/product/bomba-aceite-citroen-peugeot-1-6-n-16v-21d/');
  assert.ok(rule);

  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "BOMBA ACEITE CITROEN-PEUGEOT 1.6 N 16v (21D)",
            "url": "https://www.selvir.com.uy/product/bomba-aceite-citroen-peugeot-1-6-n-16v-21d/",
            "offers": {
              "priceSpecification": [
                {
                  "@type": "UnitPriceSpecification",
                  "price": "3426.00",
                  "priceCurrency": "UYU"
                }
              ],
              "availability": "https://schema.org/InStock"
            }
          }
        </script>
      </head>
      <body>
        <main>
          <h1 class="product-info-title">BOMBA ACEITE CITROEN-PEUGEOT 1.6 N 16v (21D)</h1>
          <div class="product-info-price">
            <span class="price-number">$3.426</span>
          </div>
          <button>Comprar</button>
        </main>
        <aside class="related">
          <div class="product-info-title">OTRO PRODUCTO</div>
          <span class="price-number">$1.782</span>
        </aside>
      </body>
    </html>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.selvir.com.uy/product/bomba-aceite-citroen-peugeot-1-6-n-16v-21d/', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'BOMBA ACEITE CITROEN-PEUGEOT 1.6 N 16v (21D)');
  assert.equal(products[0].price, '3.426');
  assert.equal(products[0].sourceUrl, 'https://www.selvir.com.uy/product/bomba-aceite-citroen-peugeot-1-6-n-16v-21d/');
});

test('ignora links de categoria Selvir al extraer productos', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/product-category/carroceria/');
  assert.ok(rule);

  const html = `
    <article>
      <a href="/product-category/accesorios/">Accesorios</a>
      <a href="/product/amortiguador-del-chery-beat-13/">
        <div class="product-item-container">
          <div class="product-info-title">AMORTIGUADOR DEL CHERY BEAT 13</div>
          <span class="product-code">CÃ³digo 23152</span>
          <span class="product-info-price">
            <span class="price-number">$2.200</span>
            <span class="woocommerce-Price-SiStock">Disponible</span>
          </span>
          <div class="cart"><button>Comprar</button></div>
        </div>
      </a>
    </article>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.selvir.com.uy/product-category/carroceria/', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'AMORTIGUADOR DEL CHERY BEAT 13');
  assert.equal(products[0].price, '2.200');
});

test('descubre la paginacion Selvir como categoria y no la confunde con producto', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/product-category/carroceria/');
  assert.ok(rule);

  const html = `
    <nav class="woocommerce-pagination">
      <a class="page-numbers" href="https://www.selvir.com.uy/carroceria/page/2/">2</a>
    </nav>
    <a href="https://www.selvir.com.uy/product-category/accesorios/">Accesorios</a>
    <a href="https://wa.me/+59892735847?text=Hola">Consultar</a>
    <a href="https://www.selvir.com.uy/product/amortiguador-del-chery-beat-13/">
      <div class="product-item-container">
        <div class="product-info-title">AMORTIGUADOR DEL CHERY BEAT 13</div>
        <span class="product-code">C&oacute;digo 23152</span>
        <span class="product-info-price">
          <span class="price-number">2.200</span>
          <span class="woocommerce-Price-SiStock">Disponible</span>
        </span>
      </div>
    </a>
  `;

  const links = extractCandidateLinks(html, 'https://www.selvir.com.uy/product-category/carroceria/', rule);
  assert.ok(links.categoryLinks.includes('https://www.selvir.com.uy/carroceria/page/2/'));
  assert.ok(links.categoryLinks.includes('https://www.selvir.com.uy/product-category/accesorios/'));
  assert.equal(links.productLinks.includes('https://www.selvir.com.uy/product/amortiguador-del-chery-beat-13/'), true);
  assert.equal(links.productLinks.includes('https://www.selvir.com.uy/product-category/accesorios/'), false);
  assert.equal(links.productLinks.some((url) => url.startsWith('https://wa.me/')), false);
});

test('rechaza paginas 404 aunque tengan texto y precio', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/product/rejilla-falsa/');
  assert.ok(rule);

  const html = `
    <main>
      <h1>Â¡Vaya! No se ha podido encontrar esa pÃ¡gina.</h1>
      <div>404</div>
      <div>$404</div>
    </main>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.selvir.com.uy/product/rejilla-falsa/', 'domain', rule), rule);
  assert.equal(products.length, 0);
});

test('rechaza labels de UI y enlaces externos aunque parezcan productos', () => {
  const rule = findDomainRule('https://www.chaparei.com/productos/?m=171');
  assert.ok(rule);

  const products = qualityGate([
    {
      productName: 'Ordenar por',
      price: '100',
      sourceUrl: 'https://www.chaparei.com/productos/?m=171',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
    {
      productName: 'TORTA ROCKY 41 TIROS',
      price: '1990',
      sourceUrl: 'https://www.mundopirotecnico.uy/catalogo/tortas-y-festivales/linea-tradicional/torta-rocky-41-tiros-nuevo-2023-mp1006/',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
  ], rule);

  assert.equal(products.length, 0);
});

test('deduplica por sourceUrl sin perder datos utiles', () => {
  const products = dedupeProducts([
    {
      productName: 'Demo',
      price: '100',
      sourceUrl: 'https://example.com/p/1',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
    {
      productName: 'Demo',
      price: '100',
      sourceUrl: 'https://example.com/p/1',
      description: 'Detalle',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
  ]);

  assert.equal(products.length, 1);
  assert.equal(products[0].description, 'Detalle');
});

test('resume warnings de calidad por tipo', () => {
  const counts = countQualityWarnings([
    {
      productName: 'A',
      price: '100',
      sourceUrl: 'https://example.com/a',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
      qualityWarnings: ['missing_price', 'not_sellable'],
    },
    {
      productName: 'B',
      price: '200',
      sourceUrl: 'https://example.com/b',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
      qualityWarnings: ['not_sellable'],
    },
  ]);

  assert.deepEqual(counts, {
    missing_price: 1,
    not_sellable: 2,
  });
});

