import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalogSite } from './catalog-sites';
import { WooCommerceAdapter } from './adapters/woocommerce.adapter';

test('Repuestos Avenida enables its WooCommerce shop', () => {
  const site = getCatalogSite('repuestosavenida');
  assert.ok(site);
  assert.equal(site.enabled, true);
  assert.equal(site.platform, 'woocommerce');
  assert.equal(site.seedUrls[0], 'https://repuestosavenida.com.uy/tienda/');
  assert.ok(site.productUrlPatterns.some((rule) => rule.test('https://repuestosavenida.com.uy/producto/farol-hb20/')));
});

test('Repuestos Avenida extracts main and gallery product images before header logos', async () => {
  const productUrl = 'https://repuestosavenida.com.uy/producto/circuito-soquete-de-faro-trasero-derecho-volkswagen-saveiro-g7-g8-2017-2022-5-pines';
  const mainImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/product-70f98bcca7e264cc5547b1be4b7d6468__optimized.webp';
  const secondImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/product-13e742e4bd66a36c573d061a058b1bea__optimized.webp';
  const logoImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/logo-a2a53ee977a6081ebe8554ae62ab13d2__md.webp';
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta property="og:image" content="${mainImage}">
        <link rel="preload" href="${logoImage}" as="image">
      </head>
      <body>
        <header>
          <img class="st-brand-logo" src="${logoImage}" alt="Repuestos Avenida">
        </header>
        <main>
          <article
            class="storefront-product"
            data-gallery="[{&quot;url&quot;:&quot;${mainImage}&quot;,&quot;preview_url&quot;:&quot;${mainImage.replace('.webp', '__sm.webp')}&quot;,&quot;role&quot;:&quot;main&quot;},{&quot;url&quot;:&quot;${secondImage}&quot;,&quot;preview_url&quot;:&quot;${secondImage.replace('.webp', '__sm.webp')}&quot;}]"
          >
            <h1>Circuito / Soquete de Faro Trasero Derecho Volkswagen Saveiro</h1>
            <div class="storefront-product-price"><span>$1.000,00</span></div>
            <div class="storefront-product-stage" data-st-product-stage>
              <img class="storefront-product-image" data-role="main-image" src="${mainImage}" alt="Circuito / Soquete de Faro Trasero Derecho Volkswagen Saveiro">
            </div>
            <div class="storefront-product-gallery" data-role="gallery">
              <button type="button" class="storefront-product-thumb is-active" data-thumb-url="${mainImage}">
                <img src="${mainImage.replace('.webp', '__sm.webp')}" alt="" loading="lazy">
              </button>
            </div>
          </article>
          <section class="storefront-related-card">
            <img src="https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/product-related__lg.webp" alt="Producto relacionado">
          </section>
        </main>
      </body>
    </html>
  `;

  const [product] = await extractRepuestosAvenidaProducts(html, productUrl);

  assert.equal(product.imageUrl, mainImage);
  assert.deepEqual(product.imageUrls, [mainImage, secondImage]);
  assert.equal(product.imageUrl?.includes('logo'), false);
  assert.equal(product.imageUrls?.some((url) => url.includes('related')), false);
});

test('Repuestos Avenida rejects logo images and selects the first valid product image', async () => {
  const productUrl = 'https://repuestosavenida.com.uy/producto/producto-con-logo-en-galeria';
  const logoImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/logo-a2a53ee977a6081ebe8554ae62ab13d2__md.webp';
  const placeholderImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/placeholder.webp';
  const validImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/product-valid.webp';
  const html = `
    <article
      class="storefront-product"
      data-gallery="[{&quot;url&quot;:&quot;${logoImage}&quot;},{&quot;url&quot;:&quot;${placeholderImage}&quot;},{&quot;url&quot;:&quot;${validImage}&quot;}]"
    >
      <h1>Producto con galería ruidosa</h1>
      <div class="storefront-product-price"><span>$1.000,00</span></div>
    </article>
  `;

  const [product] = await extractRepuestosAvenidaProducts(html, productUrl);

  assert.equal(product.imageUrl, validImage);
  assert.deepEqual(product.imageUrls, [validImage]);
});

test('Repuestos Avenida leaves image empty when only logo assets are available', async () => {
  const productUrl = 'https://repuestosavenida.com.uy/producto/producto-sin-foto';
  const logoImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/logo-a2a53ee977a6081ebe8554ae62ab13d2__md.webp';
  const html = `
    <html>
      <head>
        <meta property="og:image" content="${logoImage}">
      </head>
      <body>
        <article class="storefront-product">
          <h1>Producto sin foto real</h1>
          <div class="storefront-product-price"><span>$1.000,00</span></div>
          <img class="storefront-product-image" data-role="main-image" src="${logoImage}" alt="Repuestos Avenida">
        </article>
      </body>
    </html>
  `;

  const [product] = await extractRepuestosAvenidaProducts(html, productUrl);

  assert.equal(product.imageUrl, undefined);
  assert.equal(product.imageUrls, undefined);
});

test('Repuestos Avenida change does not alter generic WooCommerce image extraction for other domains', async () => {
  const site = getCatalogSite('autopartesgil');
  assert.ok(site);

  const sourceUrl = 'https://autopartesgil.com/producto/faro-demo/';
  const firstImage = 'https://autopartesgil.com/wp-content/uploads/logo-demo.webp';
  const secondImage = 'https://autopartesgil.com/wp-content/uploads/faro-demo.webp';
  const adapter = new WooCommerceAdapter();
  const result = await adapter.extract({
    site,
    fetch: async () => ({
      url: sourceUrl,
      finalUrl: sourceUrl,
      statusCode: 200,
      headers: {},
      body: `
        <html>
          <body>
            <main>
              <h1>Faro demo</h1>
              <p class="price">$1.500</p>
              <img src="${firstImage}" alt="Logo demo">
              <img src="${secondImage}" alt="Faro demo">
            </main>
          </body>
        </html>
      `,
    }),
  }, [sourceUrl]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.products[0].imageUrl, firstImage);
});

async function extractRepuestosAvenidaProducts(html: string, productUrl: string) {
  const site = getCatalogSite('repuestosavenida');
  assert.ok(site);

  const adapter = new WooCommerceAdapter();
  const result = await adapter.extract({
    site,
    fetch: async () => ({
      url: productUrl,
      finalUrl: productUrl,
      statusCode: 200,
      headers: {},
      body: html,
    }),
  }, [productUrl]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.products.length, 1);
  return result.products;
}
