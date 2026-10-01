import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalogSite } from './catalog-sites';
import { extractRomyProduct } from './adapters/woocommerce.adapter';
import { authenticateCatalogSite } from './catalog-pipeline';
import { readFile } from 'node:fs/promises';
import { isValidCatalogSku } from './adapters/base.adapter';

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

        return {
          url,
          finalUrl: url,
          statusCode: 200,
          headers: {},
          body: '<main>Mi cuenta</main>',
        };
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
      <div class="woocommerce-product-gallery">
        <img src="https://romy.uy/cargador.jpg">
      </div>

      <div class="summary entry-summary">
        <h1 class="product_title">
          Cargador De Batería FOXSUR / 12V-4A
        </h1>

        <p class="price">
          <del>
            <span class="woocommerce-Price-amount">
              u$s21.90
            </span>
          </del>

          <ins>
            <span class="woocommerce-Price-amount">
              u$s20.90
            </span>
          </ins>

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
    {
      attributes: {
        attribute_colores: 'Negro',
      },
      is_in_stock: true,
      variation_is_active: true,
    },
    {
      attributes: {
        attribute_colores: 'Rojo',
      },
      is_in_stock: false,
      variation_is_active: true,
    },
  ]).replaceAll('"', '&quot;');

  const product = extractRomyProduct(`
    <div class="summary">
      <h1 class="product_title">
        Cargador inalámbrico
      </h1>

      <p class="price">
        <span class="woocommerce-Price-amount">
          u$s5.5
        </span>
      </p>

      <span class="sku">car123</span>

      <p class="stock out-of-stock">
        Agotado
      </p>

      <form
        class="variations_form"
        data-product_variations="${variations}"
      >
        <select name="attribute_colores">
          <option value="">
            Elige una opción
          </option>

          <option value="negro">
            Negro
          </option>

          <option value="rojo">
            Rojo
          </option>
        </select>
      </form>
    </div>
  `, 'https://romy.uy/producto/cargador-inalambrico/');

  assert.ok(product);
  assert.equal(product.stock, '0');
  assert.equal(product.availability, 'out_of_stock');
  assert.equal(product.attributes?.colors, 'Negro | Rojo');

  assert.deepEqual(
    JSON.parse(product.attributes?.colorStock ?? '{}'),
    {
      Negro: 'in_stock',
      Rojo: 'out_of_stock',
    },
  );

  assert.equal(product.attributes?.isOffer, 'false');
});

test('Romy prefers full-size gallery images and rejects non-product assets', () => {
  const product = extractRomyProduct(`
    <head>
      <meta
        property="og:image"
        content="https://romy.uy/wp-content/uploads/site-logo.png"
      >
    </head>

    <main>
      <div class="woocommerce-product-gallery">
        <figure class="woocommerce-product-gallery__wrapper">

          <div class="woocommerce-product-gallery__image">
            <a href="https://romy.uy/wp-content/uploads/2026/09/producto-frente.jpg">
              <img
                src="https://romy.uy/wp-content/uploads/2026/09/producto-frente-150x150.jpg"
                data-large_image="https://romy.uy/wp-content/uploads/2026/09/producto-frente.jpg"
              >
            </a>
          </div>

          <div class="woocommerce-product-gallery__image">
            <img
              src="/wp-content/uploads/2026/09/producto-dorso-300x300.jpg"
              data-original="/wp-content/uploads/2026/09/producto-dorso.jpg"
            >
          </div>

          <div class="woocommerce-product-gallery__image">
            <img
              src="https://romy.uy/wp-content/themes/romy/images/placeholder.png"
            >
          </div>

        </figure>
      </div>

      <div class="summary">
        <h1 class="product_title">
          Producto con galería
        </h1>

        <p class="price">
          <span class="woocommerce-Price-amount">
            u$s10
          </span>
        </p>

        <p class="stock in-stock">
          Disponible
        </p>
      </div>
    </main>
  `, 'https://romy.uy/producto/producto-con-galeria/');

  assert.ok(product);

  assert.equal(
    product.imageUrl,
    'https://romy.uy/wp-content/uploads/2026/09/producto-frente.jpg',
  );

  assert.deepEqual(
    product.imageUrls,
    [
      'https://romy.uy/wp-content/uploads/2026/09/producto-frente.jpg',
      'https://romy.uy/wp-content/uploads/2026/09/producto-dorso.jpg',
    ],
  );
});

test('catalog SKU metric rejects missing-value placeholders without inventing a SKU', () => {
  for (
    const value of [
      undefined,
      '',
      ' ',
      'N/D',
      'N.A',
      'S/D',
      'Sin datos',
      'No disponible',
      '-',
    ]
  ) {
    assert.equal(
      isValidCatalogSku(value),
      false,
      `expected ${String(value)} to be invalid`,
    );
  }

  assert.equal(
    isValidCatalogSku('var1248'),
    true,
  );

  const product = extractRomyProduct(`
    <div class="summary">

      <h1 class="product_title">
        Producto sin SKU
      </h1>

      <p class="price">
        u$s10
      </p>

      <span class="sku">
        N/D
      </span>

      <p class="stock in-stock">
        Disponible
      </p>

    </div>
  `, 'https://romy.uy/producto/producto-sin-sku/');

  assert.ok(product);
  assert.equal(product.sku, undefined);
});

test('Romy only marks a real lower sale price as an offer', () => {
  const scenarios = [
    {
      regular: '0.10',
      sale: undefined,
      expected: 'false',
    },
    {
      regular: '0.10',
      sale: '0.10',
      expected: 'false',
    },
    {
      regular: '21.90',
      sale: '20.90',
      expected: 'true',
    },
  ];

  for (const scenario of scenarios) {
    const priceHtml = scenario.sale
      ? `
        <del>
          <span class="woocommerce-Price-amount">
            u$s${scenario.regular}
          </span>
        </del>

        <ins>
          <span class="woocommerce-Price-amount">
            u$s${scenario.sale}
          </span>
        </ins>
      `
      : `
        <span class="woocommerce-Price-amount">
          u$s${scenario.regular}
        </span>
      `;

    const product = extractRomyProduct(`
      <span class="onsale">
        ¡Oferta!
      </span>

      <div class="summary">

        <h1 class="product_title">
          Producto
        </h1>

        <p class="price">
          ${priceHtml}
        </p>

        <p class="stock in-stock">
          Disponible
        </p>

      </div>
    `, 'https://romy.uy/producto/producto/');

    assert.ok(product);

    assert.equal(
      product.attributes?.isOffer,
      scenario.expected,
    );
  }
});