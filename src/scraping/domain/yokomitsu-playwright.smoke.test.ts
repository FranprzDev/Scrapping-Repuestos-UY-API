import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import {
  detectYokomitsuCaptcha,
  extractYokomitsuProductsFromDom,
} from './yokomitsu-playwright';

test('Yokomitsu Playwright smoke no depende de helpers serializados por esbuild', async (t) => {
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright Chromium no disponible: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const page = await browser.newPage();
  try {
    await page.goto(dataUrl(`
      <html><body>
        <script src="https://www.google.com/recaptcha/api.js"></script>
        <iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor" style="display:none"></iframe>
        <div class="g-recaptcha" style="width: 300px; height: 80px;">captcha visible</div>
      </body></html>
    `));
    assert.equal(await detectYokomitsuCaptcha(page), true);

    await page.goto(dataUrl(`
      <html><body>
        <script src="https://www.google.com/recaptcha/api.js"></script>
        <iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor" style="display:none"></iframe>
      </body></html>
    `));
    assert.equal(await detectYokomitsuCaptcha(page), false);

    await page.goto(dataUrl(`
      <html><body>
        <article class="producto" data-codprod="YK-001">
          <a href="/v2/producto/YK-001"><h3>Filtro de aceite</h3></a>
          <span class="codigo">YK-001</span>
          <strong class="precio">$U 1.234,50</strong>
          <img src="/imagenes/filtro.jpg">
        </article>
      </body></html>
    `));
    const products = await extractYokomitsuProductsFromDom(page, 'https://www.yokomitsuparts.com.uy/v2/');
    assert.equal(products.length, 1);
    assert.equal(products[0].productName, 'Filtro de aceite');
    assert.equal(products[0].sku, 'YK-001');
    assert.equal(products[0].sourceUrl, 'https://www.yokomitsuparts.com.uy/v2/producto/YK-001');
    assert.equal(products[0].imageUrl, 'https://www.yokomitsuparts.com.uy/imagenes/filtro.jpg');
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
});

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
