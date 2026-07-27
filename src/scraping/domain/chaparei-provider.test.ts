import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DomainProvider } from '../providers/domain.provider';
import { PlaywrightProvider } from '../providers/playwright.provider';
import { HttpRequestInit, HttpResponseData } from './http-client';

test('Chaparei integra marcas, categorias, reintento AJAX, agotados y detalles sin precio', async () => {
  const calls = new Map<string, number>();
  const productOne = 'https://www.chaparei.com/catalogo/carroceria/puerta-tras-der-k0801480/';
  const productTwo = 'https://www.chaparei.com/catalogo/espejos-e-iluminacion/espejo-ext-izq-electrico-p-pintar-tyc-k2902751/';

  const fetchPage = async (url: string): Promise<HttpResponseData> => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    const parsed = new URL(url);

    if (parsed.pathname === '/productos/' && !parsed.search) {
      return htmlResponse(url, `
        <select id="id_marca"><option value="">Marca...</option><option value="171">KIA</option></select>
        <nav><a href="/productos/?c=44">Carrocería</a></nav>
      `);
    }

    if (parsed.pathname === '/productos/' && parsed.searchParams.get('m') === '171') {
      return htmlResponse(url, `
        <select id="id_marca"><option value="171" selected>KIA</option></select>
        ${chapareiCard(productOne, 'PUERTA TRAS. DER.', 'KIA PICANTO', undefined, true)}
      `);
    }

    if (parsed.pathname === '/productos/' && parsed.searchParams.get('c') === '44') {
      return htmlResponse(url, chapareiCard(productTwo, 'ESPEJO EXT. IZQ. ELECTRICO', 'TOYOTA COROLLA', '$U 8.900', false));
    }

    if (parsed.pathname.endsWith('/cargar_pagina_dinamica.php')) {
      const isBrandPage = parsed.searchParams.get('m') === '171';
      const attempt = calls.get(url) ?? 0;
      if (isBrandPage && attempt === 1) {
        return htmlResponse(url, '');
      }
      return htmlResponse(url, isBrandPage && attempt === 2
        ? chapareiCard(productTwo, 'ESPEJO EXT. IZQ. ELECTRICO', 'KIA RIO', '$U 8.900', false)
        : '');
    }

    if (url === productOne) {
      return htmlResponse(url, `
        <main><h1>PUERTA TRAS. DER.</h1><div itemprop="sku">Código: K0801480</div>
        <h2 class="copete_ficha">KIA PICANTO</h2><button>Consultar</button></main>
      `);
    }

    if (url === productTwo) {
      return htmlResponse(url, `
        <main><h1>ESPEJO EXT. IZQ. ELECTRICO</h1><div itemprop="sku">K2902751</div>
        <h2 class="copete_ficha">TOYOTA COROLLA</h2><span itemprop="price">8.900</span><button>Comprar</button></main>
      `);
    }

    throw new Error(`Unexpected Chaparei request: ${url}`);
  };

  const provider = new TestDomainProvider({} as PlaywrightProvider, fetchPage);
  const crawl = await provider.run('crawl', { url: 'https://www.chaparei.com/productos/', limit: 20 });
  const discovered = (crawl.raw as { discoveredUrls: string[] }).discoveredUrls;
  assert.ok(discovered.includes('https://www.chaparei.com/productos/?m=171'));
  assert.ok(discovered.includes('https://www.chaparei.com/productos/?c=44'));

  const result = await provider.run('extract', {
    url: 'https://www.chaparei.com/productos/',
    urls: discovered,
    maxItems: 100,
  });

  assert.equal(result.normalizedProducts.length, 2);
  const door = result.normalizedProducts.find((product) => product.sourceUrl === productOne);
  assert.equal(door?.sku, 'K0801480');
  assert.equal(door?.price, undefined);
  assert.equal(door?.availability, 'out_of_stock');
  const mirror = result.normalizedProducts.find((product) => product.sourceUrl === productTwo);
  assert.equal(mirror?.sku, 'K2902751');
  assert.equal(mirror?.price, '8.900');

  const brandAjax = Array.from(calls.entries()).find(([url]) =>
    url.includes('cargar_pagina_dinamica.php') && url.includes('m=171'));
  assert.equal(brandAjax?.[1], 2, 'la primera pagina vacia se consulta nuevamente');
  assert.ok(Array.from(calls.keys()).some((url) =>
    url.includes('cargar_pagina_dinamica.php') && url.includes('m=171') && url.includes('nro_pag=2')));
});

class TestDomainProvider extends DomainProvider {
  constructor(playwright: PlaywrightProvider, private readonly mockFetch: (url: string) => Promise<HttpResponseData>) {
    super(playwright);
  }

  protected override fetchPage(url: string, _redirects = 5, _init: HttpRequestInit = {}): Promise<HttpResponseData> {
    return this.mockFetch(url);
  }
}

function htmlResponse(url: string, body: string): HttpResponseData {
  return {
    url,
    finalUrl: url,
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'PHPSESSID=test; Path=/' },
    body,
  };
}

function chapareiCard(
  sourceUrl: string,
  name: string,
  compatibility: string,
  price?: string,
  outOfStock = false,
): string {
  return `
    <article class="prod_item${outOfStock ? ' prod_sin_stock' : ''}">
      <a href="${sourceUrl}"><img src="/producto.jpg" alt="${name}"></a>
      <h2><a href="${sourceUrl}"><span itemprop="name">${name}</span></a></h2>
      <h2 class="copete_ficha">${compatibility}</h2>
      ${price ? `<span itemprop="price">${price}</span>` : ''}
      <button>${outOfStock ? 'Consultar' : 'Comprar'}</button>
    </article>
  `;
}
