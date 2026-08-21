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

test('Repuestos Avenida extracts product gallery images before header logos', async () => {
  const productUrl = 'https://repuestosavenida.com.uy/producto/central-multimedia-mp5-para-volkswagen-gol-voyage-y-saveiro-2008-2012-kit-completo-con-camara-de-re-y-moldura';
  const productImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/product-37d92e5b68157fac9fc3536498ed42d0.webp';
  const secondProductImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/product-gallery-extra.webp';
  const logoImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/logo-a2a53ee977a6081ebe8554ae62ab13d2__md.webp';
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta property="og:image" content="${productImage}">
        <link rel="preload" href="${logoImage}" as="image">
      </head>
      <body>
        <header>
          <img class="st-brand-logo" src="${logoImage}" alt="Repuestos Avenida">
        </header>
        <main>
          <article
            class="storefront-product"
            data-gallery="[{&quot;url&quot;:&quot;${productImage}&quot;,&quot;preview_url&quot;:&quot;${productImage.replace('.webp', '__sm.webp')}&quot;,&quot;role&quot;:&quot;main&quot;},{&quot;url&quot;:&quot;${secondProductImage}&quot;,&quot;preview_url&quot;:&quot;${secondProductImage.replace('.webp', '__sm.webp')}&quot;}]"
          >
            <h1>Central Multimedia MP5 para Volkswagen Gol</h1>
            <div class="storefront-product-price"><span>$6.130,00</span></div>
            <div class="storefront-product-stage" data-st-product-stage>
              <img class="storefront-product-image" data-role="main-image" src="${productImage}" alt="Central Multimedia MP5 para Volkswagen Gol">
            </div>
            <div class="storefront-product-gallery" data-role="gallery">
              <button type="button" class="storefront-product-thumb is-active" data-thumb-url="${productImage}">
                <img src="${productImage.replace('.webp', '__sm.webp')}" alt="" loading="lazy">
              </button>
            </div>
          </article>
        </main>
      </body>
    </html>
  `;

  const [product] = await extractRepuestosAvenidaProducts(html, productUrl);

  assert.equal(product.imageUrl, productImage);
  assert.deepEqual(product.imageUrls, [productImage, secondProductImage]);
  assert.equal(product.imageUrl?.includes('logo'), false);
  assert.equal(product.imageUrls?.some((url) => url.includes('logo')), false);
});

test('Repuestos Avenida rejects logo-only og:image fallback', async () => {
  const productUrl = 'https://repuestosavenida.com.uy/producto/producto-sin-foto';
  const logoImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/logo-a2a53ee977a6081ebe8554ae62ab13d2__md.webp';
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta property="og:image" content="${logoImage}">
      </head>
      <body>
        <article class="storefront-product">
          <h1>Producto sin foto real</h1>
          <div class="storefront-product-price"><span>$1.000,00</span></div>
        </article>
      </body>
    </html>
  `;

  const [product] = await extractRepuestosAvenidaProducts(html, productUrl);

  assert.equal(product.imageUrl, undefined);
  assert.equal(product.imageUrls, undefined);
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
