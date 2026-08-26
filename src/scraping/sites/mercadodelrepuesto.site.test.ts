import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductRecord } from '../interfaces/scraping.types';
import { GenericHtmlPaginationAdapter } from './adapters/generic-html-pagination.adapter';
import { getCatalogSite } from './catalog-sites';
import type { CatalogSiteConfig } from './types';

class TestAdapter extends GenericHtmlPaginationAdapter {
  extractForTest(site: CatalogSiteConfig, html: string, pageUrl: string): ProductRecord[] {
    return this.extractProductsFromBody(site, html, pageUrl);
  }
}

test('Mercado del Repuesto is enabled with page-param pagination', () => {
  const site = getCatalogSite('mercadodelrepuesto');

  assert.ok(site);
  assert.equal(site.enabled, true);
  assert.equal(site.platform, 'generic-html');
  assert.deepEqual(site.paginationStrategy, {
    type: 'page-param',
    param: 'page',
    start: 1,
    maxPages: 1000,
  });
  assert.equal(site.concurrency, 4);
  assert.ok(site.productUrlPatterns.some((pattern) => pattern.test(
    'https://www.mercadodelrepuesto.com/repuesto/8bdd828a-c7c3-49a4-8cc3-4f9c59c77116',
  )));
});

test('Mercado del Repuesto parser extracts the product detail without the USD approximation', () => {
  const site = getCatalogSite('mercadodelrepuesto');
  assert.ok(site);

  const html = `
    <!doctype html>
    <html lang="es">
      <body>
        <main>
          <h1>TAPA CILINDRO VW POLO 1.9SDI 1Z AFN</h1>
          <div>CÓD. 79.1150</div>
          <div>$ 30.184</div>
          <div>≈ US$ 728,2 aprox.</div>
          <div>Disponible</div>
          <img src="https://acesur.uy/fotos/grandes/79_1150-FotoGrande-377591.jpg" alt="TAPA CILINDRO VW POLO 1.9SDI 1Z AFN" />
          <span class="flex flex-col gap-0.5 border border-line px-2.5 py-2 leading-tight">
            <span>Volkswagen POLO</span>
            <span>Todos los años</span>
          </span>
          <h2>Descripción</h2>
          <p>Rubro: ELECTRICIDAD | Subrubro: VARIOS | Marca: VW POLO 1.9 SDI</p>
          <h2>Características</h2>
        </main>
      </body>
    </html>
  `;

  const product = new TestAdapter().extractForTest(
    site,
    html,
    'https://www.mercadodelrepuesto.com/repuesto/8bdd828a-c7c3-49a4-8cc3-4f9c59c77116',
  )[0];

  assert.ok(product);
  assert.equal(product.productName, 'TAPA CILINDRO VW POLO 1.9SDI 1Z AFN');
  assert.equal(product.sku, '79.1150');
  assert.equal(product.price, '30184');
  assert.equal(product.currency, 'UYU');
  assert.equal(product.availability, 'disponible');
  assert.equal(product.category, 'ELECTRICIDAD');
  assert.equal(product.attributes?.subrubro, 'VARIOS');
  assert.equal(product.imageUrl, 'https://acesur.uy/fotos/grandes/79_1150-FotoGrande-377591.jpg');
  assert.deepEqual(product.compatibleVehicles, ['Volkswagen POLO Todos los años']);
  assert.notEqual(product.price, '728,2');
});
