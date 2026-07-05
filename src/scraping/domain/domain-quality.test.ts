import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { findDomainRule } from './domain-rules';
import {
  buildGrFrenosBrandUrl,
  extractCandidateLinks,
  extractChapareiBrandsFromHtml,
  extractGrFrenosBrandsFromHtml,
  extractGrFrenosListingSummary,
  extractProductsFromHtml,
  isGrFrenosChallengeHtml,
} from './domain-html';
import { countQualityWarnings, dedupeProducts, isAllowedCatalogUrl, isSellableProduct, qualityGate } from './product-quality';
import {
  applyChapareiContextBrand,
  applyGrFrenosContextBrand,
  buildSelvirArchivePageUrl,
  cleanSelvirLabel,
  extractAcesurProductsByRubro,
  extractChapareiBrandLabelFromUrl,
  extractSelvirArchiveSummary,
  extractTaxitorPaginationSummary,
  parseSelvirAjaxResponse,
  buildAcesurEndpoint,
  parseAcesurFilterOptions,
} from '../providers/domain.provider';

test('rechaza productos agotados en cards tipo Chaparei', () => {
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
  assert.equal(products.length, 0);
});

test('ignora cards Chaparei con clase prod_sin_stock aunque no digan agotado en el texto', () => {
  const rule = findDomainRule('https://www.chaparei.com/productos/?m=171');
  assert.ok(rule);

  const html = `
    <article class="prod_item prod_sin_stock">
      <div class="foto">
        <a href="/catalogo/carroceria/guardabarro-tras-izq-t1501180/" target="_blank">
          <img src="https://www.chaparei.com/imgs/productos/productos31_93938.jpg" alt="GUARDABARRO TRAS. IZQ.">
        </a>
      </div>
      <div class="cont">
        <h2><a href="/catalogo/carroceria/guardabarro-tras-izq-t1501180/"><span itemprop="name">GUARDABARRO TRAS. IZQ.</span></a></h2>
        <h2 class="copete_ficha">FIAT TIPO</h2>
      </div>
      <div class="opcionespreciocont">
        <div class="precios">
          <div class="precio_cont" itemprop="offers">
            <span class="ele">
              <span class="pmoneda">$U</span>
              <span id="precio_ent_actual" itemprop="price" content="8.579">8.579</span>
            </span>
          </div>
        </div>
      </div>
      <div class="opcionescarrito">
        <div class="opciones_cart">
          <div class="submit prod_reservar"><button type="button"><span>Consultar</span></button></div>
        </div>
      </div>
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

test('detecta la paginacion Taxitor desde rel=next y data-ci-pagination-page', () => {
  const html = `
    <nav aria-label="navigation " class="py-2 my-2">
      <ul class="pagination pagination-md">
        <li class="active"><span>1<span></span></span></li>
        <li><a href="https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/30" data-ci-pagination-page="2">2</a></li>
        <li><a href="https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/60" data-ci-pagination-page="3">3</a></li>
        <li><a href="https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/30" data-ci-pagination-page="2" rel="next">›</a></li>
        <li><a href="https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/28170" data-ci-pagination-page="940">»</a></li>
      </ul>
    </nav>
  `;

  const summary = extractTaxitorPaginationSummary(html, 'https://taxitor.uy/articulos/filtro/1/-/-/');

  assert.equal(summary.currentPage, 1);
  assert.equal(summary.nextPageUrl, 'https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/30');
  assert.equal(summary.lastPageUrl, 'https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/28170');
});

test('detecta el fin Taxitor cuando ya no hay next', () => {
  const html = `
    <nav aria-label="navigation " class="py-2 my-2">
      <ul class="pagination pagination-md">
        <li><a href="https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/28140" data-ci-pagination-page="939" rel="prev">‹</a></li>
        <li><a href="https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/" data-ci-pagination-page="1" rel="start">1</a></li>
        <li class="active"><span>940<span></span></span></li>
      </ul>
    </nav>
  `;

  const summary = extractTaxitorPaginationSummary(html, 'https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/28170');

  assert.equal(summary.currentPage, 940);
  assert.equal(summary.nextPageUrl, undefined);
  assert.equal(summary.lastPageUrl, undefined);
});

test('extrae listados Taxitor y evita confundir la paginacion con un detalle', () => {
  const rule = findDomainRule('https://taxitor.uy/articulos/filtro/1/-/-/');
  assert.ok(rule);

  const html = `
    <main>
      <div class="row">
        <div class="col-12 col-sm-6 col-md-4 col-xl-4">
          <div class="single-product-wrapper p-4">
            <div class="product-img pb-3">
              <a href="https://taxitor.uy/articulos/mostrar/1319">
                <img src="https://taxitor.uy/articulos/resize_image/1319.jpg" alt="">
              </a>
            </div>
            <div class="product-description">
              <div class="product-meta-data">
                <h3 class="pixelato-inner-title">
                  <a href="https://taxitor.uy/articulos/mostrar/1319">
                    ABRAZADERA CREMALLERA SUPRENS 13MM-19MM x 100 SURTIDAS 20%DCTO
                  </a>
                </h3>
                <p class="product-price">
                  $ 39.74
                  <span class="ti-1" style="color:red">Antes:</span>
                </p>
              </div>
              <div class="product-buttons">
                <button>Agregar al carrito</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <nav aria-label="navigation " class="py-2 my-2">
        <ul class="pagination pagination-md">
          <li class="active"><span>1<span></span></span></li>
          <li><a href="https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/30" data-ci-pagination-page="2" rel="next">›</a></li>
        </ul>
      </nav>
    </main>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://taxitor.uy/articulos/filtro/1/-/-/', 'domain', rule), rule);

  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'ABRAZADERA CREMALLERA SUPRENS 13MM-19MM x 100 SURTIDAS 20%DCTO');
  assert.equal(products[0].price, '39.74');
  assert.equal(products[0].sourceUrl, 'https://taxitor.uy/articulos/mostrar/1319');
});

test('no duplica productos Taxitor al unir paginas consecutivas', () => {
  const rule = findDomainRule('https://taxitor.uy/articulos/filtro/1/-/-/');
  assert.ok(rule);

  const page1 = `
    <main>
      <div class="single-product-wrapper p-4">
        <div class="product-img pb-3">
          <a href="https://taxitor.uy/articulos/mostrar/1319"><img src="https://taxitor.uy/articulos/resize_image/1319.jpg" alt=""></a>
        </div>
        <div class="product-description">
          <h3 class="pixelato-inner-title"><a href="https://taxitor.uy/articulos/mostrar/1319">ABRAZADERA CREMALLERA SUPRENS 13MM-19MM x 100 SURTIDAS 20%DCTO</a></h3>
          <p class="product-price">$ 39.74</p>
        </div>
      </div>
      <div class="single-product-wrapper p-4">
        <div class="product-img pb-3">
          <a href="https://taxitor.uy/articulos/mostrar/1320"><img src="https://taxitor.uy/articulos/resize_image/1320.jpg" alt=""></a>
        </div>
        <div class="product-description">
          <h3 class="pixelato-inner-title"><a href="https://taxitor.uy/articulos/mostrar/1320">ABRAZADERA METALICA 20-25</a></h3>
          <p class="product-price">$ 48.10</p>
        </div>
      </div>
    </main>
  `;

  const page2 = `
    <main>
      <div class="single-product-wrapper p-4">
        <div class="product-img pb-3">
          <a href="https://taxitor.uy/articulos/mostrar/1319"><img src="https://taxitor.uy/articulos/resize_image/1319.jpg" alt=""></a>
        </div>
        <div class="product-description">
          <h3 class="pixelato-inner-title"><a href="https://taxitor.uy/articulos/mostrar/1319">ABRAZADERA CREMALLERA SUPRENS 13MM-19MM x 100 SURTIDAS 20%DCTO</a></h3>
          <p class="product-price">$ 39.74</p>
        </div>
      </div>
      <div class="single-product-wrapper p-4">
        <div class="product-img pb-3">
          <a href="https://taxitor.uy/articulos/mostrar/1321"><img src="https://taxitor.uy/articulos/resize_image/1321.jpg" alt=""></a>
        </div>
        <div class="product-description">
          <h3 class="pixelato-inner-title"><a href="https://taxitor.uy/articulos/mostrar/1321">ABRAZADERA METALICA 25-30</a></h3>
          <p class="product-price">$ 51.25</p>
        </div>
      </div>
    </main>
  `;

  const merged = dedupeProducts([
    ...qualityGate(extractProductsFromHtml(page1, 'https://taxitor.uy/articulos/filtro/1/-/-/', 'domain', rule), rule),
    ...qualityGate(extractProductsFromHtml(page2, 'https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/30', 'domain', rule), rule),
  ]);

  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((product) => product.sourceUrl),
    [
      'https://taxitor.uy/articulos/mostrar/1319',
      'https://taxitor.uy/articulos/mostrar/1320',
      'https://taxitor.uy/articulos/mostrar/1321',
    ],
  );
});

test('Taxitor live crawl devuelve un producto correcto por cada pagina recorrida', async () => {
  const rule = findDomainRule('https://taxitor.uy/articulos/filtro/1/-/-/');
  assert.ok(rule);

  const pages = [
    {
      url: 'https://taxitor.uy/articulos/filtro/1/-/-/',
      expected: {
        productName: 'ABRAZADERA CREMALLERA SUPRENS 13MM-19MM x 100 SURTIDAS 20%DCTO',
        sourceUrl: 'https://taxitor.uy/articulos/mostrar/1319',
        price: '39.74',
      },
    },
    {
      url: 'https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/30',
      expected: {
        productName: 'ACEITE FEBI (10W40 X LITRO ) 15000KM IVECO MB SCANIA VOLVO',
        sourceUrl: 'https://taxitor.uy/articulos/mostrar/34049FB',
        price: '328.36',
      },
    },
    {
      url: 'https://taxitor.uy/articulos/filtro/1/-/-/-/-/-/-/60',
      expected: {
        productName: 'ACOPLE MOVIMIENTO CAMBIOS VW SENDA CAÑON TL7465AC U EXPOYER EX1002096',
        sourceUrl: 'https://taxitor.uy/articulos/mostrar/807711559',
        price: '524.26',
      },
    },
  ] as const;

  for (const page of pages) {
    const response = await fetch(page.url, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        referer: 'https://taxitor.uy/',
      },
    });

    assert.equal(response.status, 200, `expected 200 for ${page.url}`);

    const html = await response.text();
    const products = qualityGate(extractProductsFromHtml(html, response.url, 'domain', rule), rule);
    const matched = products.find(
      (product) =>
        product.productName === page.expected.productName &&
        product.sourceUrl === page.expected.sourceUrl &&
        product.price === page.expected.price,
    );

    assert.ok(matched, `expected a valid product on ${page.url}`);
    assert.equal(matched?.sourceUrl, page.expected.sourceUrl);
    assert.equal(matched?.productName, page.expected.productName);
    assert.equal(matched?.price, page.expected.price);
  }
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

test('permite el buscardor de marcas de GR Frenos sin habilitar rutas de busqueda', () => {
  const baseUrl = 'https://www.grfrenos.uy/home/';

  assert.equal(
    isAllowedCatalogUrl('https://www.grfrenos.uy/buscardor.php?marcas=128---', baseUrl),
    true,
  );
  assert.equal(
    isAllowedCatalogUrl('https://www.grfrenos.uy/buscar/?q=ford', baseUrl),
    false,
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

test('extrae marcas Chaparei desde el select de value numerico', () => {
  const html = `
    <select id="id_marca" onchange="get_modelos(this.value,0);">
      <option value="">Marca...</option>
      <option value="157">ALFA ROMEO</option>
      <option value="172">FORD</option>
      <option value="195">VOLVO</option>
    </select>
  `;

  const brands = extractChapareiBrandsFromHtml(html, 'https://www.chaparei.com/productos/');

  assert.deepEqual(brands, [
    {
      brandId: '157',
      brandLabel: 'ALFA ROMEO',
      sourceUrl: 'https://www.chaparei.com/productos/?m=157',
    },
    {
      brandId: '172',
      brandLabel: 'FORD',
      sourceUrl: 'https://www.chaparei.com/productos/?m=172',
    },
    {
      brandId: '195',
      brandLabel: 'VOLVO',
      sourceUrl: 'https://www.chaparei.com/productos/?m=195',
    },
  ]);
});

test('resuelve la marca contextual de Chaparei desde el brandUrl y la aplica al producto', () => {
  const brands = [
    { brandId: '157', brandLabel: 'ALFA ROMEO' },
    { brandId: '172', brandLabel: 'CHEVROLET' },
  ];

  const contextualBrand = extractChapareiBrandLabelFromUrl('https://www.chaparei.com/productos/?m=172', brands);
  assert.equal(contextualBrand, 'CHEVROLET');

  const products = applyChapareiContextBrand([{
    productName: 'FOCO DELANTERO',
    sourceUrl: 'https://www.chaparei.com/catalogo/otros/foco-demo/',
    extractedAt: new Date().toISOString(),
    provider: 'domain',
  }], contextualBrand);

  assert.equal(products[0].brand, 'CHEVROLET');
});

test('extrae marcas GR Frenos desde el select y normaliza labels a ASCII', () => {
  const html = `
    <select id="marcax" class="form-control-chosen" data-placeholder="Buscar Marca">
      <option value="">Seleccione la Marca</option>
      <option value="3594">ABARTH</option>
      <option value="93">BYD</option>
      <option value="64">ALFA ROMEO</option>
      <option value="3835">SETRA</option>
      <option value="231">CITROËN</option>
    </select>
  `;

  const brands = extractGrFrenosBrandsFromHtml(html, 'https://www.grfrenos.uy/home/');

  assert.deepEqual(brands, [
    {
      brandId: '3594',
      brandLabel: 'Abarth',
      sourceUrl: 'https://www.grfrenos.uy/buscardor.php?marcas=3594---',
    },
    {
      brandId: '93',
      brandLabel: 'BYD',
      sourceUrl: 'https://www.grfrenos.uy/buscardor.php?marcas=93---',
    },
    {
      brandId: '64',
      brandLabel: 'Alfa Romeo',
      sourceUrl: 'https://www.grfrenos.uy/buscardor.php?marcas=64---',
    },
    {
      brandId: '3835',
      brandLabel: 'Setra',
      sourceUrl: 'https://www.grfrenos.uy/buscardor.php?marcas=3835---',
    },
    {
      brandId: '231',
      brandLabel: 'Citroen',
      sourceUrl: 'https://www.grfrenos.uy/buscardor.php?marcas=231---',
    },
  ]);
});

test('resume el total de resultados de GR Frenos desde h1 y h3', () => {
  const html = `
    <section class="niveles">
      <div class="niveles__cabezal" id="listado">
        <div class="niveles__cabezal--titulo">
          <h1>SETRA</h1>
          <h3>1 resultados</h3>
        </div>
      </div>
    </section>
  `;

  const summary = extractGrFrenosListingSummary(html);
  assert.equal(summary?.brandLabel, 'Setra');
  assert.equal(summary?.totalResults, 1);
});

test('agrega la marca consultada a las compatibilidades de GR Frenos', () => {
  const products = applyGrFrenosContextBrand([{
    productName: 'Pastilla de freno',
    price: '100',
    sourceUrl: 'https://www.grfrenos.uy/pastilla/art-1/',
    compatibleBrands: ['Volkswagen'],
    extractedAt: new Date().toISOString(),
    provider: 'domain',
  }], 'Ford');

  assert.deepEqual(products[0].compatibleBrands, ['Volkswagen', 'Ford']);
});

test('arma la url final de GR Frenos con paginacion total', () => {
  const url = buildGrFrenosBrandUrl('https://www.grfrenos.uy/buscardor.php?marcas=3835---', '3835', 64);

  assert.equal(url, 'https://www.grfrenos.uy/buscardor.php?marcas=3835---&paginacion=64');
});

test('detecta html challenge de GR Frenos', () => {
  const html = `
    <html>
      <body>
        <h1>Access denied</h1>
        <p>Please verify you are human</p>
      </body>
    </html>
  `;

  assert.equal(isGrFrenosChallengeHtml(html), true);
});

test('no inventa totalResults cuando el h3 no trae resultados', () => {
  const html = `
    <section class="niveles">
      <div class="niveles__cabezal--titulo">
        <h1>SETRA</h1>
        <h3>Sin datos</h3>
      </div>
    </section>
  `;

  const summary = extractGrFrenosListingSummary(html);
  assert.equal(summary?.brandLabel, 'Setra');
  assert.equal(summary?.totalResults, undefined);
});

test('extrae tarjetas reales de GR Frenos sin confundir Ver modelos con el producto', () => {
  const rule = findDomainRule('https://www.grfrenos.uy/buscardor.php?marcas=3835---');
  assert.ok(rule);

  const html = `
    <section class="listados">
      <div class="listados__productos-sin-lateral" id="listadogrid">
        <div class="listados__productos--item">
          <article class="card__producto--item">
            <div class="card__producto--item--img">
              <a href="https://www.grfrenos.uy/kit-reparacion-de-mordaza-d4617-45/art-9016/" target="_top">
                <img src="https://www.grfrenos.uy/imagenes/img_contenido/productos/b/D4617(45).jpg" alt="Kit Reparación de Mordaza D4617 (45)" />
              </a>
            </div>
            <div class="card__producto--item--info">
              <div class="card__producto--item--info--titulo">
                <h3>
                  <a href="https://www.grfrenos.uy/kit-reparacion-de-mordaza-d4617-45/art-9016/" target="_top">Kit Reparación de Mordaza D4617 (45)</a>
                </h3>
                <div class="card__producto--item--info--titulo--modelos">
                  <div class="card__producto--item--info--titulo--modelos--linea">
                    <h4>Marcas compatibles:</h4>
                    <div class="card__producto--item--info--titulo--modelos--linea--marcas">
                      <h5>CITROËN</h5>
                      <h5>SETRA</h5>
                      <h5>BYD</h5>
                      <a href="https://www.grfrenos.uy/kit-reparacion-de-mordaza-d4617-45/art-9016/">+ Ver modelos</a>
                    </div>
                  </div>
                </div>
              </div>
              <div class="card__producto--item--info--tools">
                <div class="card__producto--item--info--tools--pie">
                  <h4><strong>$</strong>892</h4>
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.grfrenos.uy/buscardor.php?marcas=3835---', 'domain', rule), rule);
  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'Kit Reparación de Mordaza D4617 (45)');
  assert.equal(products[0].sourceUrl, 'https://www.grfrenos.uy/kit-reparacion-de-mordaza-d4617-45/art-9016/');
  assert.equal(products[0].price, '892');
  assert.deepEqual(products[0].compatibleBrands, ['Citroen', 'Setra', 'BYD']);
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

test('limpia nombres y precios de listados Selvir', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/amortiguadores/');
  assert.ok(rule);

  const html = `
    <article class="product-item-container">
      <a href="/product/amortiguador-del-chery-beat-13/">
        <div class="product-info">
          <div class="product-info-title">AMORTIGUADOR DEL CHERY BEAT 13 Código 23152 $ 2.200 Disponible Comprar</div>
          <div class="product-info-price">
            <span class="woocommerce-Price-amount amount">
              <span class="woocommerce-Price-currencySymbol">$</span>
              <span class="woocommerce-Price-currency">2.200</span>
            </span>
          </div>
        </div>
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

test('no confunde Consulte con agotado por defecto', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/product-category/suspension/');
  assert.ok(rule);

  const products = qualityGate([
    {
      productName: 'AMORTIGUADOR DEMO',
      price: '1234',
      availability: 'unknown',
      sourceUrl: 'https://www.selvir.com.uy/product/amortiguador-demo/',
      description: 'Consulte disponibilidad',
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
  ], rule);

  assert.equal(products.length, 1);
});

test('resume correctamente el archive de Selvir y limpia labels de categoria', () => {
  const html = `
    <html>
      <head><title>Arranques y alternadores archivos - Selvir</title></head>
      <body>
        <main>
          <h1>Inicio / Arranques y alternadores Orden predeterminado</h1>
          <div>Mostrando 1-30 de 405 resultados</div>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/arranques-y-alternadores/');
  assert.equal(summary?.categoryLabel, 'Arranques y alternadores');
  assert.equal(summary?.totalResults, 405);
  assert.equal(summary?.totalPages, 14);
  assert.equal(cleanSelvirLabel('Inicio / Accesorios Orden predeterminado'), 'Accesorios');
});

test('resume Accesorios de Selvir con el conteo base esperado', () => {
  const html = `
    <html>
      <head><title>Accesorios archivos - Selvir</title></head>
      <body>
        <main>
          <h1>Inicio / Accesorios Orden predeterminado</h1>
          <div>Mostrando 1-30 de 506 resultados</div>
          <button>Cargar más</button>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/product-category/accesorios/');
  assert.equal(summary?.categoryLabel, 'Accesorios');
  assert.equal(summary?.totalResults, 506);
  assert.equal(summary?.totalPages, 17);
});

test('desempaqueta la respuesta ajax de Selvir y conserva el html util', () => {
  const payload = parseSelvirAjaxResponse(JSON.stringify({
    d: '<div class="product-item-container"><a href="/product/demo/">Demo</a></div>',
    cantArticulos: 30,
    last: false,
  }));

  assert.equal(payload.html.includes('product-item-container'), true);
  assert.equal(payload.cantArticulos, 30);
  assert.equal(payload.last, false);
});

test('acepta respuestas ajax de Selvir en html plano como fallback', () => {
  const payload = parseSelvirAjaxResponse('<div class="product-item-container">Demo</div>');

  assert.equal(payload.html.includes('product-item-container'), true);
  assert.equal(payload.cantArticulos, undefined);
  assert.equal(payload.last, undefined);
});

test('acepta respuestas ajax de Selvir vacias sin romper el desempaque', () => {
  const payload = parseSelvirAjaxResponse(JSON.stringify({
    d: '',
    cantArticulos: 0,
    last: false,
  }));

  assert.equal(payload.html, '');
  assert.equal(payload.cantArticulos, 0);
  assert.equal(payload.last, false);
});

test('construye la url de fallback de paginas Selvir', () => {
  assert.equal(
    buildSelvirArchivePageUrl('https://www.selvir.com.uy/limpieza-cuidado-y-emergencia/', 2),
    'https://www.selvir.com.uy/limpieza-cuidado-y-emergencia/page/2/',
  );
});

test('resume una categoria grande de Selvir con Cargar mas sin meter ruido extra', () => {
  const html = `
    <html>
      <head><title>Carrocería archivos - Selvir</title></head>
      <body>
        <main>
          <h1>Inicio / Carrocería Orden predeterminado</h1>
          <div>Mostrando 1–30 de 23795 resultados</div>
          <button>Cargar más</button>
          <div>Se ha añadido el artículo al carrito.</div>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/product-category/carroceria/');
  assert.equal(summary?.categoryLabel, 'Carrocería');
  assert.equal(summary?.totalResults, 23795);
  assert.equal(summary?.totalPages, 794);
});

test('resume otra categoria grande de Selvir con el mismo patron', () => {
  const html = `
    <html>
      <head><title>Motor archivos - Selvir</title></head>
      <body>
        <main>
          <h1>Inicio / Motor Orden predeterminado</h1>
          <div>Mostrando 1–30 de 5922 resultados</div>
          <button>Cargar más</button>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/product-category/motor/');
  assert.equal(summary?.categoryLabel, 'Motor');
  assert.equal(summary?.totalResults, 5922);
  assert.equal(summary?.totalPages, 198);
});

test('resume suspension de Selvir con el mismo archive summary', () => {
  const html = `
    <html>
      <head><title>Suspensión archivos - Selvir</title></head>
      <body>
        <main>
          <h1>Inicio / Suspensión Orden predeterminado</h1>
          <div>Mostrando 1–30 de 5040 resultados</div>
          <button>Cargar más</button>
          <div>Consulte Disponibilidad</div>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/product-category/suspension/');
  assert.equal(summary?.categoryLabel, 'Suspensión');
  assert.equal(summary?.totalResults, 5040);
  assert.equal(summary?.totalPages, 168);
});

test('resume Bombas de Selvir con el mismo archive summary', () => {
  const html = `
    <html>
      <head><title>Bombas archivos - Selvir</title></head>
      <body>
        <main>
          <h1>Inicio / Bombas Orden predeterminado</h1>
          <div>Mostrando 1–30 de 1619 resultados</div>
          <button>Cargar más</button>
          <div>Consulte Disponibilidad</div>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/product-category/bombas/');
  assert.equal(summary?.categoryLabel, 'Bombas');
  assert.equal(summary?.totalResults, 1619);
  assert.equal(summary?.totalPages, 54);
});

test('resume otras categorias del menu de Selvir sin arrastrar ruido de breadcrumb', () => {
  const cases = [
    {
      html: `
        <html>
          <head><title>Aceites archivos - Selvir</title></head>
          <body>
            <main>
              <h1>Home / Productos / Aceites Orden predeterminado</h1>
              <div>Mostrando los 29 resultados</div>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/aceites/',
      category: 'Aceites',
      totalResults: 29,
      totalPages: 1,
    },
    {
      html: `
        <html>
          <head><title>Tanques y flotadores archivos - Selvir</title></head>
          <body>
            <main>
              <h1>Inicio / Productos / Tanques y flotadores Orden predeterminado</h1>
      <div>Mostrando 1–30 de 533 resultados</div>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/tanques-y-flotadores/',
      category: 'Tanques y flotadores',
      totalResults: 533,
      totalPages: 18,
    },
  ] as const;

  for (const testCase of cases) {
    const summary = extractSelvirArchiveSummary(testCase.html, testCase.url);
    assert.equal(summary?.categoryLabel, testCase.category);
    assert.equal(summary?.totalResults, testCase.totalResults);
    assert.equal(summary?.totalPages, testCase.totalPages);
  }
});

test('resume Selvir aunque el label util venga del breadcrumb y no del h1', () => {
  const html = `
    <html>
      <head><title>Filtros y soportes archivos - Selvir</title></head>
      <body>
        <main>
          <nav class="woocommerce-breadcrumb">Inicio / Productos / Filtros y soportes</nav>
          <div>Mostrando 1–30 de 1105 resultados</div>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/product-category/filtros-y-soportes/');
  assert.equal(summary?.categoryLabel, 'Filtros y soportes');
  assert.equal(summary?.totalResults, 1105);
  assert.equal(summary?.totalPages, 37);
});

test('resume Tanques y flotadores de Selvir con el mismo archive summary', () => {
  const html = `
    <html>
      <head><title>Tanques y flotadores archivos - Selvir</title></head>
      <body>
        <main>
          <h1>Inicio / Tanques y flotadores Orden predeterminado</h1>
          <div>Mostrando 1–30 de 533 resultados</div>
          <button>Cargar más</button>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/product-category/tanques-y-flotadores/');
  assert.equal(summary?.categoryLabel, 'Tanques y flotadores');
  assert.equal(summary?.totalResults, 533);
  assert.equal(summary?.totalPages, 18);
});

test('resume Lámparas de Selvir con breadcrumb compacto y conteo simple', () => {
  const html = `
    <html>
      <head><title>Lámparas archivos - Selvir</title></head>
      <body>
        <main>
          <nav class="woocommerce-breadcrumb">Inicio /Lámparas</nav>
          <div>Orden predeterminado</div>
          <div>Mostrando 1–30 de 171 resultados</div>
          <button>Cargar más</button>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/product-category/lamparas/');
  assert.equal(summary?.categoryLabel, 'Lámparas');
  assert.equal(summary?.totalResults, 171);
  assert.equal(summary?.totalPages, 6);
});

test('resume Herramientas de Selvir con breadcrumb simple y conteo estable', () => {
  const html = `
    <html>
      <head><title>Herramientas archivos - Selvir</title></head>
      <body>
        <main>
          <h1>Inicio / Herramientas Orden predeterminado</h1>
          <div>Mostrando 1–30 de 878 resultados</div>
          <button>Cargar más</button>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/product-category/herramientas/');
  assert.equal(summary?.categoryLabel, 'Herramientas');
  assert.equal(summary?.totalResults, 878);
  assert.equal(summary?.totalPages, 30);
});

test('extrae productos de Ofertas de Selvir sin meter ruido de menu', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/ofertas/');
  assert.ok(rule);

  const html = `
    <html>
      <body>
        <main>
          <div class="product-item-container">
            <a href="https://www.selvir.com.uy/product/silla-bebe-de-9-meses-a-12-anos-lila-y-blanca/">
              <div class="product-info">
                <div class="product-info-title">SILLA BEBE DE 9 MESES A 12 AÑOS LILA Y BLANCA</div>
                <div class="product-info-price">
                  <span class="woocommerce-Price-amount amount">
                    <span class="woocommerce-Price-currencySymbol">$</span>
                    <span class="woocommerce-Price-currency">2.735</span>
                  </span>
                </div>
              </div>
            </a>
          </div>
          <div class="product-item-container">
            <a href="https://www.selvir.com.uy/product/taladro-a-bateria-13mm-20v-4a-cargador-2-baterias/">
              <div class="product-info">
                <div class="product-info-title">TALADRO A BATERIA 13mm 20V 4A +CARGADOR+2 BATERIAS</div>
                <div class="product-info-price">
                  <span class="woocommerce-Price-amount amount">
                    <span class="woocommerce-Price-currencySymbol">$</span>
                    <span class="woocommerce-Price-currency">6.085</span>
                  </span>
                </div>
              </div>
            </a>
          </div>
        </main>
      </body>
    </html>
  `;

  const products = qualityGate(extractProductsFromHtml(html, 'https://www.selvir.com.uy/ofertas/', 'domain', rule), rule);
  assert.equal(products.length, 2);
  assert.equal(products[0]?.productName, 'SILLA BEBE DE 9 MESES A 12 AÑOS LILA Y BLANCA');
  assert.equal(products[1]?.productName, 'TALADRO A BATERIA 13mm 20V 4A +CARGADOR+2 BATERIAS');
});

test('no confunde Camiones con un archive Selvir', () => {
  const html = `
    <html>
      <head><title>Camiones - Selvir</title></head>
      <body>
        <main>
          <h1>Camiones</h1>
          <section>
            <h2>¿Qué necesitas hoy?</h2>
          </section>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/camiones/');
  assert.equal(summary, undefined);
});

test('no confunde Limpieza y mantenimiento del vehículo con un archive Selvir', () => {
  const html = `
    <html>
      <head><title>Limpieza y mantenimiento del vehículo - Selvir</title></head>
      <body>
        <main>
          <h1>Limpieza y mantenimiento del vehículo</h1>
          <section>
            <h2>Productos destacados</h2>
          </section>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/limpieza-y-mantenimiento-del-vehiculo/');
  assert.equal(summary, undefined);
});

test('no confunde la home de Selvir con un archive', () => {
  const html = `
    <html>
      <head><title>Homepage - Selvir</title></head>
      <body>
        <main>
          <h1>Productos</h1>
          <section>
            <h2>Selecciona una marca</h2>
          </section>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/');
  assert.equal(summary, undefined);
});

test('no confunde una pagina generica de Productos con un archive Selvir', () => {
  const html = `
    <html>
      <head><title>Productos - Selvir</title></head>
      <body>
        <main>
          <h1>Productos</h1>
          <p>Selecciona una marca para comenzar</p>
          <div class="brand-list">
            <a href="/?marca=ford">Ford</a>
            <a href="/?marca=fiat">Fiat</a>
            <a href="/?marca=vw">VW</a>
          </div>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/productos/');
  assert.equal(summary, undefined);
});

test('no convierte la lista de marcas y modelos de la home de Selvir en links de categoria', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/');
  assert.ok(rule);

  const html = `
    <main>
      <div class="brand-list">
        <a href="/?marca=ford">FORD</a>
        <a href="/?marca=fiat">FIAT</a>
        <a href="/?marca=vw">VW</a>
      </div>
      <div class="model-list">
        <a href="/?modelo=focus">FOCUS</a>
        <a href="/?modelo=uno">UNO</a>
      </div>
    </main>
  `;

  const links = extractCandidateLinks(html, 'https://www.selvir.com.uy/', rule);
  assert.equal(links.categoryLinks.length, 0);
  assert.equal(links.productLinks.length, 0);
});

test('no convierte links de marca y modelo de la home de Selvir en links de categoria aunque parezcan navegables', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/');
  assert.ok(rule);

  const html = `
    <main>
      <div class="brand-list">
        <a href="/?marca=ford">FORD</a>
        <a href="/?marca=fiat">FIAT</a>
      </div>
      <div class="model-list">
        <a href="/?modelo=focus">FOCUS</a>
        <a href="/?modelo=uno">UNO</a>
      </div>
    </main>
  `;

  const links = extractCandidateLinks(html, 'https://www.selvir.com.uy/', rule);
  assert.equal(links.categoryLinks.length, 0);
  assert.equal(links.productLinks.length, 0);
});

test('ignora enlaces de marca y modelo en Selvir aunque aparezcan dentro de un bloque navegable', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/');
  assert.ok(rule);

  const html = `
    <main>
      <div class="brand-list">
        <a href="/?marca=ford">Ford</a>
        <a href="/?marca=fiat">Fiat</a>
        <a href="/?marca=vw">VW</a>
      </div>
      <div class="model-list">
        <a href="/?modelo=focus">Focus</a>
        <a href="/?modelo=uno">Uno</a>
        <a href="/?modelo=fiesta">Fiesta</a>
      </div>
    </main>
  `;

  const links = extractCandidateLinks(html, 'https://www.selvir.com.uy/', rule);
  assert.equal(links.categoryLinks.some((url) => url.includes('marca=')), false);
  assert.equal(links.categoryLinks.some((url) => url.includes('modelo=')), false);
  assert.equal(links.productLinks.some((url) => url.includes('marca=')), false);
  assert.equal(links.productLinks.some((url) => url.includes('modelo=')), false);
});

test('descubre el enlace Ver todos los productos de la home de Selvir sin duplicarlo', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/');
  assert.ok(rule);

  const html = `
    <main>
      <a href="/productos/">Ver todos los productos</a>
      <div class="brand-list">
        <a href="/?marca=ford">Ford</a>
      </div>
    </main>
  `;

  const links = extractCandidateLinks(html, 'https://www.selvir.com.uy/', rule);
  assert.equal(links.categoryLinks.includes('https://www.selvir.com.uy/productos/'), false);
  assert.equal(links.productLinks.includes('https://www.selvir.com.uy/productos/'), false);
});

test('descubre las categorias reales de Selvir desde la home y no incluye hubs ajenos', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/');
  assert.ok(rule);

  const html = `
    <main>
      <a href="/product-category/accesorios/">Accesorios</a>
      <a href="/product-category/arranques-y-alternadores/">Arranques y alternadores</a>
      <a href="/product-category/carroceria/">Carrocería</a>
      <a href="/product-category/filtros-y-soportes/">Filtros y soportes</a>
      <a href="/productos/">Ver todos los productos</a>
      <a href="/camiones/">Camiones</a>
      <a href="/blog/">Blog</a>
    </main>
  `;

  const links = extractCandidateLinks(html, 'https://www.selvir.com.uy/', rule);
  assert.equal(links.categoryLinks.includes('https://www.selvir.com.uy/product-category/accesorios/'), true);
  assert.equal(links.categoryLinks.includes('https://www.selvir.com.uy/product-category/arranques-y-alternadores/'), true);
  assert.equal(links.categoryLinks.includes('https://www.selvir.com.uy/product-category/carroceria/'), true);
  assert.equal(links.categoryLinks.includes('https://www.selvir.com.uy/product-category/filtros-y-soportes/'), true);
  assert.equal(links.categoryLinks.includes('https://www.selvir.com.uy/productos/'), false);
  assert.equal(links.categoryLinks.includes('https://www.selvir.com.uy/camiones/'), false);
  assert.equal(links.categoryLinks.includes('https://www.selvir.com.uy/blog/'), false);
});

test('cubre todas las categorias reales de Selvir que expone la home', () => {
  const rule = findDomainRule('https://www.selvir.com.uy/');
  assert.ok(rule);

  const html = `
    <main>
      <a href="/product-category/accesorios/">Accesorios</a>
      <a href="/product-category/aceites/">Aceites</a>
      <a href="/product-category/arranques-y-alternadores/">Arranques y alternadores</a>
      <a href="/product-category/bombas/">Bombas</a>
      <a href="/product-category/carroceria/">Carrocería</a>
      <a href="/product-category/correas/">Correas</a>
      <a href="/product-category/diferencial-y-cardan/">Diferencial Y Cardan</a>
      <a href="/product-category/direccion/">Dirección</a>
      <a href="/product-category/filtros-y-soportes/">Filtros y soportes</a>
      <a href="/product-category/freno-y-embrague/">Freno y embrague</a>
      <a href="/product-category/herramientas/">Herramientas</a>
      <a href="/product-category/lamparas/">Lámparas</a>
      <a href="/product-category/limpieza-cuidado-y-emergencia/">Limpieza, cuidado y emergencia</a>
      <a href="/product-category/mangones-y-canos/">Mangones Y Caños</a>
      <a href="/product-category/motor/">Motor</a>
      <a href="/product-category/neumaticos/">Neumáticos</a>
      <a href="/product-category/otros/">Otros</a>
      <a href="/product-category/sensores/">Sensores</a>
      <a href="/product-category/suspension/">Suspensión</a>
      <a href="/product-category/tanques-y-flotadores/">Tanques y flotadores</a>
    </main>
  `;

  const links = extractCandidateLinks(html, 'https://www.selvir.com.uy/', rule);
  const discovered = new Set(links.categoryLinks);

  const expected = [
    'https://www.selvir.com.uy/product-category/accesorios/',
    'https://www.selvir.com.uy/product-category/aceites/',
    'https://www.selvir.com.uy/product-category/arranques-y-alternadores/',
    'https://www.selvir.com.uy/product-category/bombas/',
    'https://www.selvir.com.uy/product-category/carroceria/',
    'https://www.selvir.com.uy/product-category/correas/',
    'https://www.selvir.com.uy/product-category/diferencial-y-cardan/',
    'https://www.selvir.com.uy/product-category/direccion/',
    'https://www.selvir.com.uy/product-category/filtros-y-soportes/',
    'https://www.selvir.com.uy/product-category/freno-y-embrague/',
    'https://www.selvir.com.uy/product-category/herramientas/',
    'https://www.selvir.com.uy/product-category/lamparas/',
    'https://www.selvir.com.uy/product-category/limpieza-cuidado-y-emergencia/',
    'https://www.selvir.com.uy/product-category/mangones-y-canos/',
    'https://www.selvir.com.uy/product-category/motor/',
    'https://www.selvir.com.uy/product-category/neumaticos/',
    'https://www.selvir.com.uy/product-category/otros/',
    'https://www.selvir.com.uy/product-category/sensores/',
    'https://www.selvir.com.uy/product-category/suspension/',
    'https://www.selvir.com.uy/product-category/tanques-y-flotadores/',
  ];

  for (const url of expected) {
    assert.equal(discovered.has(url), true, `missing category link ${url}`);
  }
});

test('no confunde Blog y Contacto de Selvir con archives', () => {
  const cases = [
    {
      html: `
        <html>
          <head><title>Blog - Selvir</title></head>
          <body>
            <main>
              <h1>Blog</h1>
              <section>
                <p>Noticias y novedades</p>
              </section>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/blog/',
    },
    {
      html: `
        <html>
          <head><title>Contacto - Selvir</title></head>
          <body>
            <main>
              <h1>Contacto</h1>
              <section>
                <p>Escribinos y te ayudamos</p>
              </section>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/contacto/',
    },
  ] as const;

  for (const testCase of cases) {
    const summary = extractSelvirArchiveSummary(testCase.html, testCase.url);
    assert.equal(summary, undefined);
  }
});

test('resume Otros de Selvir con archive simple y conteo estable', () => {
  const html = `
    <html>
      <head><title>Otros archivos - Selvir</title></head>
      <body>
        <main>
          <h1>Inicio / Otros Orden predeterminado</h1>
          <div>Mostrando 1–30 de 61 resultados</div>
          <button>Cargar más</button>
        </main>
      </body>
    </html>
  `;

  const summary = extractSelvirArchiveSummary(html, 'https://www.selvir.com.uy/otros/');
  assert.equal(summary?.categoryLabel, 'Otros');
  assert.equal(summary?.totalResults, 61);
  assert.equal(summary?.totalPages, 3);
});

test('resume Diferencial Y Cardan y Aceites Varios de Selvir con el mismo archive summary', () => {
  const cases = [
    {
      html: `
        <html>
          <head><title>Diferencial Y Cardan archivos - Selvir</title></head>
          <body>
            <main>
              <h1>Inicio / Diferencial Y Cardan Orden predeterminado</h1>
              <div>Mostrando 1–30 de 230 resultados</div>
              <button>Cargar más</button>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/diferencial-y-cardan/',
      category: 'Diferencial Y Cardan',
      totalResults: 230,
      totalPages: 8,
    },
    {
      html: `
        <html>
          <head><title>Aceites Varios archivos - Selvir</title></head>
          <body>
            <main>
              <nav class="woocommerce-breadcrumb">Inicio / Productos / Aceites Varios</nav>
              <div>Mostrando los 2 resultados</div>
              <button>Cargar más</button>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/aceites-varios/',
      category: 'Aceites Varios',
      totalResults: 2,
      totalPages: 1,
    },
  ] as const;

  for (const testCase of cases) {
    const summary = extractSelvirArchiveSummary(testCase.html, testCase.url);
    assert.equal(summary?.categoryLabel, testCase.category);
    assert.equal(summary?.totalResults, testCase.totalResults);
    assert.equal(summary?.totalPages, testCase.totalPages);
  }
});

test('resume Correas y Mangones Y Caños de Selvir sin perder la categoria', () => {
  const cases = [
    {
      html: `
        <html>
          <head><title>Correas archivos - Selvir</title></head>
          <body>
            <main>
              <h1>Inicio / Correas Orden predeterminado</h1>
              <div>Mostrando 1–30 de 735 resultados</div>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/correas/',
      category: 'Correas',
      totalResults: 735,
      totalPages: 25,
    },
    {
      html: `
        <html>
          <head><title>Mangones Y Caños archivos - Selvir</title></head>
          <body>
            <main>
              <nav class="woocommerce-breadcrumb">Inicio / Productos / Mangones Y Caños</nav>
              <div>Mostrando 1-30 de 80 resultados</div>
              <button>Cargar más</button>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/mangones-y-canos/',
      category: 'Mangones Y Caños',
      totalResults: 80,
      totalPages: 3,
    },
  ] as const;

  for (const testCase of cases) {
    const summary = extractSelvirArchiveSummary(testCase.html, testCase.url);
    assert.equal(summary?.categoryLabel, testCase.category);
    assert.equal(summary?.totalResults, testCase.totalResults);
    assert.equal(summary?.totalPages, testCase.totalPages);
  }
});

test('resume Direccion y Freno y embrague como categorias validas de Selvir', () => {
  const cases = [
    {
      html: `
        <html>
          <head><title>Dirección archivos - Selvir</title></head>
          <body>
            <main>
              <h1>Inicio / Productos / Dirección Orden predeterminado</h1>
              <div>Mostrando 1–30 de 2260 resultados</div>
              <button>Cargar más</button>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/direccion/',
      category: 'Dirección',
      totalResults: 2260,
      totalPages: 76,
    },
    {
      html: `
        <html>
          <head><title>Freno y embrague archivos - Selvir</title></head>
          <body>
            <main>
              <nav class="woocommerce-breadcrumb">Inicio / Productos / Freno y embrague</nav>
              <div>Mostrando 1-30 de 3595 resultados</div>
              <button>Cargar más</button>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/freno-y-embrague/',
      category: 'Freno y embrague',
      totalResults: 3595,
      totalPages: 120,
    },
  ] as const;

  for (const testCase of cases) {
    const summary = extractSelvirArchiveSummary(testCase.html, testCase.url);
    assert.equal(summary?.categoryLabel, testCase.category);
    assert.equal(summary?.totalResults, testCase.totalResults);
    assert.equal(summary?.totalPages, testCase.totalPages);
  }
});

test('resume Aceites y Sensores de Selvir con el mismo archive summary', () => {
  const cases = [
    {
      html: `
        <html>
          <head><title>Aceites archivos - Selvir</title></head>
          <body>
            <main>
              <h1>Inicio / Aceites Orden predeterminado</h1>
              <div>Mostrando los 29 resultados</div>
              <button>Cargar más</button>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/aceites/',
      category: 'Aceites',
      totalResults: 29,
      totalPages: 1,
    },
    {
      html: `
        <html>
          <head><title>Sensores archivos - Selvir</title></head>
          <body>
            <main>
              <nav class="woocommerce-breadcrumb">Inicio / Productos / Sensores</nav>
              <div>Mostrando 1–30 de 289 resultados</div>
              <button>Cargar más</button>
              <div>Consulte Disponibilidad</div>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/sensores/',
      category: 'Sensores',
      totalResults: 289,
      totalPages: 10,
    },
  ] as const;

  for (const testCase of cases) {
    const summary = extractSelvirArchiveSummary(testCase.html, testCase.url);
    assert.equal(summary?.categoryLabel, testCase.category);
    assert.equal(summary?.totalResults, testCase.totalResults);
    assert.equal(summary?.totalPages, testCase.totalPages);
  }
});

test('resume Neumaticos y Limpieza de Selvir sin romper acentos ni comas', () => {
  const cases = [
    {
      html: `
        <html>
          <head><title>Neumáticos archivos - Selvir</title></head>
          <body>
            <main>
              <h1>Inicio / Productos / Neumáticos Orden predeterminado</h1>
              <div>Mostrando 1–30 de 69 resultados</div>
              <button>Cargar más</button>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/neumaticos/',
      category: 'Neumáticos',
      totalResults: 69,
      totalPages: 3,
    },
    {
      html: `
        <html>
          <head><title>Limpieza, cuidado y emergencia archivos - Selvir</title></head>
          <body>
            <main>
              <nav class="woocommerce-breadcrumb">Inicio / Productos / Limpieza, cuidado y emergencia</nav>
              <div>Mostrando 1-30 de 50 resultados</div>
              <button>Cargar más</button>
            </main>
          </body>
        </html>
      `,
      url: 'https://www.selvir.com.uy/product-category/limpieza-cuidado-y-emergencia/',
      category: 'Limpieza, cuidado y emergencia',
      totalResults: 50,
      totalPages: 2,
    },
  ] as const;

  for (const testCase of cases) {
    const summary = extractSelvirArchiveSummary(testCase.html, testCase.url);
    assert.equal(summary?.categoryLabel, testCase.category);
    assert.equal(summary?.totalResults, testCase.totalResults);
    assert.equal(summary?.totalPages, testCase.totalPages);
  }
});

test('deduplica por sourceUrl sin perder datos utiles', () => {
  const products = dedupeProducts([
    {
      productName: 'Demo',
      price: '100',
      sourceUrl: 'https://example.com/p/1',
      compatibleBrands: ['Ford', 'Citroen'],
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
    {
      productName: 'Demo',
      price: '100',
      sourceUrl: 'https://example.com/p/1',
      description: 'Detalle',
      compatibleBrands: ['Volkswagen', 'CITROEN'],
      extractedAt: new Date().toISOString(),
      provider: 'domain',
    },
  ]);

  assert.equal(products.length, 1);
  assert.equal(products[0].description, 'Detalle');
  assert.deepEqual(products[0].compatibleBrands, ['Ford', 'CITROEN', 'Volkswagen']);
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

test('parsea rubros de Acesur y arma endpoints con filtros', () => {
  const rubros = parseAcesurFilterOptions(
    JSON.stringify([
      { tipo: 'A', codigo: 'Todos' },
      { tipo: 'B', codigo: 'FRENO' },
      { tipo: 'B', codigo: 'MOTOR' },
    ]),
  );

  assert.deepEqual(rubros, ['FRENO', 'MOTOR']);

  const endpoint = buildAcesurEndpoint('uuid-demo', 3, {
    primerFiltro: 'FRENO',
    segundoFiltro: 'PASTILLAS',
  });

  assert.match(endpoint, /app_obtener_productos\.php/);
  assert.match(endpoint, /pagina=3/);
  assert.match(endpoint, /primer_filtro=FRENO/);
  assert.match(endpoint, /segundo_filtro=PASTILLAS/);
});

test('arma endpoints de Acesur con codigo de cliente cuando existe', () => {
  const endpoint = buildAcesurEndpoint(
    '1172c02e-5ed8-415c-8020-7ecc522dca51',
    2,
    {
      primerFiltro: 'AMORTIGUADOR DE PUERTA',
    },
    'franutn23@gmail.com',
  );

  assert.match(endpoint, /uuid=1172c02e-5ed8-415c-8020-7ecc522dca51/);
  assert.match(
    endpoint,
    /uuid_carro=1172c02e-5ed8-415c-8020-7ecc522dca51%7Cfranutn23%40gmail\.com/,
  );
  assert.match(endpoint, /codigo_cliente=franutn23%40gmail\.com/);
  assert.match(endpoint, /primer_filtro=AMORTIGUADOR\+DE\+PUERTA/);
  assert.match(endpoint, /pagina=2/);
});

test('Acesur sigue con el siguiente rubro si uno falla', async () => {
  const warns: string[] = [];
  const products = await extractAcesurProductsByRubro(['FRENO', 'MOTOR'], {
    uuid: 'uuid-demo',
    seedUrl: 'https://acesur.example/catalogo',
    provider: 'domain',
    maxItems: 10,
    logger: {
      log() {},
      warn(message: string) {
        warns.push(message);
      },
    } as unknown as Logger,
    crawlCategory: async (_uuid, filters, _sourceUrl, _provider, _maxItems) => {
      if (filters.primerFiltro === 'FRENO') {
        throw new Error('rubro roto');
      }

      return [
        {
          productName: 'Producto MOTOR',
          price: '100',
          sourceUrl: 'https://acesur.example/producto/motor',
          extractedAt: '2026-06-14T00:00:00.000Z',
          provider: 'domain',
        },
      ];
    },
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].productName, 'Producto MOTOR');
  assert.match(warns.join('\n'), /Acesur rubro fallido rubro=FRENO/);
});
