import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fetchHtml } from './domain/http-client';
import { extractYaguaronDetail, isYaguaronProductUrl } from './domain/yaguaron';

const runLive = process.env.RUN_NEW_CATALOG_E2E === '1';

test('las nuevas casas exponen sus catálogos completos mediante los contratos validados', { skip: !runLive, timeout: 180_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });

  try {
    await t.test('Multishop responde productos Shopify paginados', async (t) => {
      const response = await fetchHtml('https://www.multishop.com.uy/products.json?limit=250&page=1');
      if (response.statusCode === 429) {
        t.skip('Shopify aplico rate limit temporal al origen de la prueba');
        return;
      }
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body) as { products?: unknown[] };
      assert.ok(Array.isArray(body.products));
      assert.ok(body.products.length > 0 && body.products.length <= 250);
    });

    await t.test('Cymaco carga páginas Fenicio por marca compatible', async () => {
      const page = await browser.newPage();
      await page.goto('https://cymaco.com.uy/catalogo?marca-comp=fiat', { waitUntil: 'domcontentloaded' });
      assert.equal(await page.locator('.aListProductos > .it').count(), 12);
      const response = await page.request.get('https://cymaco.com.uy/catalogo?marca-comp=fiat&js=1&pag=2', {
        headers: { 'x-requested-with': 'XMLHttpRequest', referer: page.url() },
      });
      assert.equal(response.ok(), true);
      assert.match(await response.text(), /aListProductos/);
      await page.close();
    });

    await t.test('Familcar carga páginas Fenicio por marca', async () => {
      const page = await browser.newPage();
      await page.goto('https://www.familcar.com/citroen', { waitUntil: 'domcontentloaded' });
      assert.equal(await page.locator('.aListProductos > .it').count(), 12);
      const total = Number(await page.locator('.aListProductos').getAttribute('data-totabs'));
      assert.ok(Number.isInteger(total) && total >= 12);
      const response = await page.request.get('https://www.familcar.com/citroen?js=1&pag=2', {
        headers: { 'x-requested-with': 'XMLHttpRequest', referer: page.url() },
      });
      assert.equal(response.ok(), true);
      assert.match(await response.text(), /aListProductos/);
      await page.close();
    });

    await t.test('Larrique entrega acumulados todos los productos de BMW', async () => {
      const page = await browser.newPage();
      await page.goto('https://larrique.com.uy/search-by/19?searchBy%5Baux1%5D=BMW&ss=closed', { waitUntil: 'domcontentloaded', timeout: 90_000 });
      assert.equal(await page.locator('a.productViewContainer').count(), 450);
      assert.match(await page.locator('body').innerText(), /450 productos/i);
      await page.close();
    });

    await t.test('Yaguarón entrega una ficha Fenicio real por HTTP', async () => {
      const url = 'https://www.yaguaron.com.uy/catalogo/kit-de-distribucion-tensor-y-correa-varios-modelos_123251_123251';
      assert.equal(isYaguaronProductUrl(url), true);
      const response = await fetchHtml(url);
      assert.equal(response.statusCode, 200);
      const product = extractYaguaronDetail(response.body, response.finalUrl, 'domain');
      assert.ok(product);
      assert.equal(product.sku, '123251');
      assert.ok(product.productName);
      assert.ok(product.imageUrl);
    });
  } finally {
    await browser.close();
  }
});
