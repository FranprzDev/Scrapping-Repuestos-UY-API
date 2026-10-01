import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalogSite } from './catalog-sites';
import { extractRomyProduct } from './adapters/woocommerce.adapter';
import { authenticateCatalogSite } from './catalog-pipeline';
import { readFile } from 'node:fs/promises';

test('Romy is enabled with authenticated WooCommerce catalog seeds', () => {
  const site = getCatalogSite('romy');
  assert.ok(site);
  assert.equal(site.enabled, true);
  assert.equal(site.platform, 'woocommerce');
  assert.equal(site.authentication.type, 'woocommerce-form');
  assert.equal(site.seedUrls.length, 19);
  assert.equal(new Set(site.seedUrls).size, site.seedUrls.length);
  assert.ok(site.seedUrls.includes('https://romy.uy/product-category/cargadores/?orderby=price'));
  assert.ok(site.seedUrls.includes('https://romy.uy/product-category/novedades/'));
  assert.ok(site.productUrlPatterns.some((pattern) => pattern.test('https://romy.uy/producto/cargador-de-bateria-foxsur-12v-4a/')));
});

test('production catalog scripts use compiled JavaScript instead of tsx', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts['catalog:audit'], 'node dist/cli/catalog-command.js --mode=audit');
  assert.equal(packageJson.scripts['catalog:run'], 'node dist/cli/catalog-command.js --mode=run');
});

test('Romy login requires environment credentials without exposing their values', async () => {
  const site = getCatalogSite('romy');
  assert.ok(site);
  await assert.rejects(
    authenticateCatalogSite(site.authentication, site.label, new Map(), { env: {} }),
    /ROMY_USERNAME.*ROMY_PASSWORD/,
  );
});

test('Romy login reads environment credentials and verifies the WordPress session cookie', async () => {
  const site = getCatalogSite('romy');
  assert.ok(site);
  const cookieJar = new Map<string, string>();
  const requests: Array<{ method: string; body?: string }> = [];

  await authenticateCatalogSite(site.authentication, site.label, cookieJar, {
    env: { ROMY_USERNAME: 'catalog-user', ROMY_PASSWORD: 'private-test-password' },
    fetcher: async (url, _redirects, init) => {
      requests.push({ method: init?.method ?? 'GET', body: init?.body });
      if (init?.method === 'POST') {
        cookieJar.set('wordpress_logged_in_test', 'private-session-cookie');
        return { url, finalUrl: url, statusCode: 200, headers: {}, body: '<main>Mi cuenta</main>' };
      }
      return {
        url,
        finalUrl: url,
        statusCode: 200,
        headers: {},
        body: '<form><input name="woocommerce-login-nonce" value="nonce"><input name="_wp_http_referer" value="/mi-cuenta/"></form>',
      };
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[1]?.method, 'POST');
  assert.match(requests[1]?.body ?? '', /username=catalog-user/);
  assert.match(requests[1]?.body ?? '', /password=private-test-password/);
  assert.equal(cookieJar.has('wordpress_logged_in_test'), true);
});

test('Romy extracts sale prices in dollars and the requested product fields', () => {
  const product = extractRomyProduct(`
    <main>
      <span class="onsale">¡Oferta!</span>
      <div class="woocommerce-product-gallery"><img src="https://romy.uy/cargador.jpg"></div>
      <div class="summary entry-summary">
        <h1 class="product_title">Cargador De Batería FOXSUR / 12V-4A</h1>
        <p class="price">
          <del><span class="woocommerce-Price-amount">u$s21.90</span></del>
          <ins><span class="woocommerce-Price-amount">u$s20.90</span></ins>
          <small>IVA Inc.</small>
        </p>
        <span class="sku">var1248</span>
        <p class="stock in-stock">Disponible</p>
      </div>
    </main>
  `, 'https://romy.uy/producto/cargador-de-bateria-foxsur-12v-4a/');

  assert.ok(product);
  assert.equal(product.productName, 'Cargador De Batería FOXSUR / 12V-4A');
  assert.equal(product.sku, 'var1248');
  assert.equal(product.price, '20.90');
  assert.equal(product.currency, 'USD');
  assert.equal(product.availability, 'in_stock');
  assert.equal(product.attributes?.regularPrice, '21.90');
  assert.equal(product.attributes?.salePrice, '20.90');
  assert.equal(product.attributes?.isOffer, 'true');
});

test('Romy extracts colors, per-color stock and sold-out state', () => {
  const variations = JSON.stringify([
    { attributes: { attribute_colores: 'Negro' }, is_in_stock: true, variation_is_active: true },
    { attributes: { attribute_colores: 'Rojo' }, is_in_stock: false, variation_is_active: true },
  ]).replaceAll('"', '&quot;');
  const product = extractRomyProduct(`
    <div class="summary">
      <h1 class="product_title">Cargador inalámbrico</h1>
      <p class="price"><span class="woocommerce-Price-amount">u$s5.5</span></p>
      <span class="sku">car123</span>
      <p class="stock out-of-stock">Agotado</p>
      <form class="variations_form" data-product_variations="${variations}">
        <select name="attribute_colores">
          <option value="">Elige una opción</option>
          <option value="negro">Negro</option>
          <option value="rojo">Rojo</option>
        </select>
      </form>
    </div>
  `, 'https://romy.uy/producto/cargador-inalambrico/');

  assert.ok(product);
  assert.equal(product.stock, '0');
  assert.equal(product.availability, 'out_of_stock');
  assert.equal(product.attributes?.colors, 'Negro | Rojo');
  assert.deepEqual(JSON.parse(product.attributes?.colorStock ?? '{}'), { Negro: 'in_stock', Rojo: 'out_of_stock' });
  assert.equal(product.attributes?.isOffer, 'false');
});
