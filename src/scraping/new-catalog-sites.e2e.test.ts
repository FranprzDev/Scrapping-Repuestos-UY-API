import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chromium } from 'playwright';

const runLive = process.env.RUN_NEW_CATALOG_E2E === '1';

test('las nuevas casas exponen sus catálogos completos mediante los contratos validados', { skip: !runLive, timeout: 180_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });

  try {
    await t.test('Multishop responde productos Shopify paginados', async () => {
      const page = await browser.newPage();
      const response = await page.request.get('https://www.multishop.com.uy/products.json?limit=250&page=1');
      assert.equal(response.ok(), true);
      const body = await response.json() as { products?: unknown[] };
      assert.equal(body.products?.length, 250);
      await page.close();
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
      assert.equal(total, 202);
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
  } finally {
    await browser.close();
  }
});
