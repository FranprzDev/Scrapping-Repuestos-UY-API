import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProductRecord } from '../interfaces/scraping.types';
import { PostgresFamilcarCymacoImageBackfillStore } from './familcar-cymaco-image-backfill-postgres';
import {
  FamilcarCymacoBackfillRow,
  FamilcarCymacoBackfillStore,
  runFamilcarCymacoImageBackfill,
} from './familcar-cymaco-image-backfill';

const familcarUrl = 'https://www.familcar.com/catalogo/tapa-de-cilindros_P160031I_P160031I';
const cymacoUrl = 'https://cymaco.com.uy/catalogo/amortiguador-fiat-del-uno-duna-premio-fiorino-34156-juego-por-2-unidades_5810_001';
const repuestosAvenidaUrl = 'https://repuestosavenida.com.uy/producto/faro-saveiro';
const italurUrl = 'https://italur.com/producto/faro-saveiro';
const familcarLogoUrl = 'https://f.fcdn.app/assets/commerce/www.familcar.com/famiuy/logoMarca.svg';
const cymacoLogoUrl = 'https://f.fcdn.app/assets/commerce/cymaco.com.uy/cymuy/logoMarca.png';
const placeholderUrl = 'https://f.fcdn.app/assets/commerce/cymaco.com.uy/cymuy/placeholder-no-image.png';
const familcarProductImage = 'https://f.fcdn.app/imgs/1a2b3c/www.familcar.com/famiuy/catalogo/P160031I/800x800/tapa-cilindros.jpg';
const familcarSecondImage = 'https://f.fcdn.app/imgs/1a2b3c/www.familcar.com/famiuy/catalogo/P160031I/800x800/tapa-cilindros-2.jpg';
const cymacoProductImage = 'https://f.fcdn.app/imgs/4d5e6f/cymaco.com.uy/cymuy/catalogo/5810/800x800/amortiguador-fiat.jpg';

test('Familcar/Cymaco image backfill package script runs the compiled production entrypoint', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  const command = packageJson.scripts['familcar-cymaco:images:backfill'];

  assert.equal(command, 'node dist/scraping/backfills/familcar-cymaco-image-backfill.cli.js');
  assert.doesNotMatch(command, /\btsx\b/);
});

test('Familcar/Cymaco image backfill processes only existing Familcar and Cymaco product URLs', async () => {
  const store = new MemoryBackfillStore([
    row('familcar-1', familcarUrl, { productName: 'Tapa de cilindros', imageUrl: familcarLogoUrl, sourceUrl: familcarUrl }),
    row('cymaco-1', cymacoUrl, { productName: 'Amortiguador Fiat', imageUrl: cymacoLogoUrl, sourceUrl: cymacoUrl }),
    row('ra-1', repuestosAvenidaUrl, { productName: 'Faro Saveiro', imageUrl: familcarLogoUrl, sourceUrl: repuestosAvenidaUrl }),
    row('other-1', italurUrl, { productName: 'Otro sitio', imageUrl: familcarLogoUrl, sourceUrl: italurUrl }),
  ]);
  const fetches: string[] = [];

  const summary = await runFamilcarCymacoImageBackfill({
    store,
    fetchProductHtml: async (sourceUrl) => {
      fetches.push(sourceUrl);
      return sourceUrl.includes('familcar')
        ? { finalUrl: familcarUrl, body: productHtml(familcarUrl, familcarProductImage) }
        : { finalUrl: cymacoUrl, body: productHtml(cymacoUrl, cymacoProductImage) };
    },
  });

  assert.deepEqual(fetches, [familcarUrl, cymacoUrl]);
  assert.equal(summary.totalCandidates, 4);
  assert.equal(summary.errors, 0);
  assert.equal(summary.items.find((item) => item.id === 'ra-1')?.reason, 'skipped_non_familcar_cymaco_source_url');
  assert.equal(summary.items.find((item) => item.id === 'other-1')?.reason, 'skipped_non_familcar_cymaco_source_url');
});

test('Familcar/Cymaco image backfill dry-run does not write and reports pending updates', async () => {
  const store = new MemoryBackfillStore([
    row('familcar-1', familcarUrl, { productName: 'Tapa de cilindros', imageUrl: familcarLogoUrl, sourceUrl: familcarUrl }),
  ]);

  const summary = await runFamilcarCymacoImageBackfill({
    limit: 5,
    store,
    fetchProductHtml: async () => ({
      finalUrl: familcarUrl,
      body: productHtml(familcarUrl, familcarProductImage, familcarSecondImage),
    }),
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.limit, 5);
  assert.equal(summary.currentLogoOrPlaceholder, 1);
  assert.equal(summary.newValidImage, 1);
  assert.equal(summary.wouldUpdate, 1);
  assert.equal(summary.updated, 0);
  assert.equal(store.updates.length, 0);
  assert.equal(summary.items[0].newImageUrl, familcarProductImage);
  assert.equal(summary.items[0].reason, 'would_update');
});

test('Familcar/Cymaco image backfill apply updates only image fields in the product payload', async () => {
  const original = row('cymaco-1', cymacoUrl, {
    productName: 'Amortiguador Fiat',
    price: '2500',
    stock: '12',
    sku: '5810',
    category: 'Suspension',
    description: 'Juego por 2 unidades',
    availability: 'in_stock',
    imageUrl: cymacoLogoUrl,
    sourceUrl: cymacoUrl,
  });
  const store = new MemoryBackfillStore([original]);

  const summary = await runFamilcarCymacoImageBackfill({
    apply: true,
    store,
    fetchProductHtml: async () => ({ finalUrl: cymacoUrl, body: productHtml(cymacoUrl, cymacoProductImage) }),
  });

  assert.equal(summary.updated, 1);
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0].id, 'cymaco-1');
  assert.equal(store.updates[0].product.productName, original.product.productName);
  assert.equal(store.updates[0].product.price, original.product.price);
  assert.equal(store.updates[0].product.stock, original.product.stock);
  assert.equal(store.updates[0].product.sku, original.product.sku);
  assert.equal(store.updates[0].product.category, original.product.category);
  assert.equal(store.updates[0].product.description, original.product.description);
  assert.equal(store.updates[0].product.sourceUrl, original.product.sourceUrl);
  assert.equal(store.updates[0].product.imageUrl, cymacoProductImage);
  assert.deepEqual(store.updates[0].product.imageUrls, [cymacoProductImage]);
  assert.equal(summary.items[0].reason, 'updated');
});

test('Familcar/Cymaco image backfill does not replace an existing image with logo or placeholder', async () => {
  const store = new MemoryBackfillStore([
    row('cymaco-1', cymacoUrl, { productName: 'Amortiguador Fiat', imageUrl: cymacoLogoUrl, sourceUrl: cymacoUrl }),
  ]);

  const summary = await runFamilcarCymacoImageBackfill({
    apply: true,
    store,
    fetchProductHtml: async () => ({ finalUrl: cymacoUrl, body: productHtml(cymacoUrl, placeholderUrl) }),
  });

  assert.equal(summary.newValidImage, 0);
  assert.equal(summary.withoutValidImage, 1);
  assert.equal(summary.wouldUpdate, 0);
  assert.equal(summary.updated, 0);
  assert.equal(store.updates.length, 0);
  assert.equal(summary.items[0].reason, 'no_valid_new_image');
});

test('Familcar/Cymaco image backfill continues when one product fetch fails', async () => {
  const store = new MemoryBackfillStore([
    row('familcar-1', familcarUrl, { productName: 'Tapa de cilindros', imageUrl: familcarLogoUrl, sourceUrl: familcarUrl }),
    row('cymaco-1', cymacoUrl, { productName: 'Amortiguador Fiat', imageUrl: cymacoLogoUrl, sourceUrl: cymacoUrl }),
  ]);

  const summary = await runFamilcarCymacoImageBackfill({
    store,
    fetchProductHtml: async (sourceUrl) => {
      if (sourceUrl.includes('familcar')) {
        throw new Error('timeout');
      }

      return { finalUrl: cymacoUrl, body: productHtml(cymacoUrl, cymacoProductImage) };
    },
  });

  assert.equal(summary.errors, 1);
  assert.equal(summary.wouldUpdate, 1);
  assert.equal(summary.items[0].reason, 'fetch_or_extract_error');
  assert.equal(summary.items[0].error, 'timeout');
  assert.equal(summary.items[1].reason, 'would_update');
});

test('Familcar/Cymaco image backfill leaves products intact when no new valid image exists', async () => {
  const store = new MemoryBackfillStore([
    row('familcar-1', familcarUrl, { productName: 'Tapa de cilindros', imageUrl: familcarLogoUrl, sourceUrl: familcarUrl }),
  ]);

  const summary = await runFamilcarCymacoImageBackfill({
    apply: true,
    store,
    fetchProductHtml: async () => ({ finalUrl: familcarUrl, body: productHtml(familcarUrl, familcarLogoUrl) }),
  });

  assert.equal(summary.withoutValidImage, 1);
  assert.equal(summary.updated, 0);
  assert.equal(store.updates.length, 0);
});

test('Postgres Familcar/Cymaco image store selects target source URLs and updates only image JSON keys', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const postgres = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  const store = new PostgresFamilcarCymacoImageBackfillStore(postgres as any);

  await store.findCandidates(20);
  await store.updateImages('cymaco-1', {
    productName: 'Amortiguador Fiat',
    price: '2500',
    stock: '12',
    sku: '5810',
    sourceUrl: cymacoUrl,
    imageUrl: cymacoProductImage,
    imageUrls: [cymacoProductImage],
    extractedAt: '2026-08-22T00:00:00.000Z',
    provider: 'domain',
  });

  assert.match(queries[0].sql, /source_url LIKE \$1 \|\| '%'/);
  assert.match(queries[0].sql, /source_url LIKE \$4 \|\| '%'/);
  assert.deepEqual(queries[0].params, [
    'https://www.familcar.com/catalogo/',
    'https://familcar.com/catalogo/',
    'https://www.cymaco.com.uy/catalogo/',
    'https://cymaco.com.uy/catalogo/',
    20,
  ]);
  assert.match(queries[1].sql, /product - 'imageUrl' - 'imageUrls'/);
  assert.match(queries[1].sql, /jsonb_set/);
  assert.doesNotMatch(queries[1].sql, /INSERT INTO scraping_inventory/i);
  assert.doesNotMatch(queries[1].sql, /\bname\b|\bprice\b|\bstock\b|\bsource_url\b|\bcategory\b|\bdescription\b|\bsku\b/i);
});

class MemoryBackfillStore implements FamilcarCymacoBackfillStore {
  readonly updates: Array<{ id: string; product: ProductRecord }> = [];

  constructor(private readonly rows: FamilcarCymacoBackfillRow[]) {}

  async findCandidates(limit?: number): Promise<FamilcarCymacoBackfillRow[]> {
    return typeof limit === 'number' ? this.rows.slice(0, limit) : this.rows;
  }

  async updateImages(id: string, product: ProductRecord): Promise<void> {
    this.updates.push({ id, product });
  }
}

function row(
  id: string,
  sourceUrl: string,
  product: Partial<ProductRecord> & Pick<ProductRecord, 'productName'>,
): FamilcarCymacoBackfillRow {
  return {
    id,
    sourceUrl,
    product: {
      extractedAt: '2026-08-22T00:00:00.000Z',
      provider: 'domain',
      ...product,
    },
  };
}

function productHtml(sourceUrl: string, mainImage: string, secondImage?: string): string {
  return `
    <html>
      <head>
        <meta property="og:image" content="${mainImage}">
        <meta property="og:url" content="${sourceUrl}">
      </head>
      <body id="pgCatalogoDetalle">
        <header>
          <img src="${familcarLogoUrl}" alt="Familcar">
          <img src="${cymacoLogoUrl}" alt="Cymaco">
        </header>
        <main id="wrapperFicha">
          <input class="json" value="{&quot;variante&quot;:{&quot;img&quot;:{&quot;u&quot;:&quot;${mainImage}&quot;}},&quot;fotos&quot;:[{&quot;u&quot;:&quot;${mainImage}&quot;}${secondImage ? `,{&quot;u&quot;:&quot;${secondImage}&quot;}` : ''}]}">
          <h1>${sourceUrl.includes('familcar') ? 'Tapa de cilindros' : 'Amortiguador Fiat'}</h1>
          <strong class="precio venta">$2.500</strong>
          <div class="galeria">
            <img src="${mainImage}" alt="Producto principal">
            ${secondImage ? `<img src="${secondImage}" alt="Producto secundario">` : ''}
          </div>
        </main>
        <section class="relacionados">
          <img src="https://f.fcdn.app/imgs/relacionados/cymaco.com.uy/cymuy/catalogo/9999/800x800/relacionado.jpg" alt="Relacionado">
        </section>
      </body>
    </html>
  `;
}
