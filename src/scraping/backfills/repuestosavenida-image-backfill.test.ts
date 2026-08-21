import test from 'node:test';
import * as assert from 'node:assert/strict';
import { ProductRecord } from '../interfaces/scraping.types';
import { PostgresRepuestosAvenidaImageBackfillStore } from './repuestosavenida-image-backfill-postgres';
import {
  RepuestosAvenidaBackfillRow,
  RepuestosAvenidaBackfillStore,
  runRepuestosAvenidaImageBackfill,
} from './repuestosavenida-image-backfill';

const productUrl = 'https://repuestosavenida.com.uy/producto/faro-saveiro';
const logoUrl = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/logo-a2a53ee977a6081ebe8554ae62ab13d2__md.webp';
const productImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/product-real.webp';
const secondProductImage = 'https://urutienda-base.nyc3.digitaloceanspaces.com/stores/513-repuestosavenidacomuy/media/2026/08/product-real-2.webp';

test('Repuestos Avenida image backfill processes only existing Repuestos Avenida product URLs', async () => {
  const store = new MemoryBackfillStore([
    row('ra-1', productUrl, { productName: 'Faro Saveiro', imageUrl: logoUrl, sourceUrl: productUrl }),
    row('other-1', 'https://italur.com/producto/faro-saveiro', { productName: 'Otro sitio', imageUrl: logoUrl, sourceUrl: 'https://italur.com/producto/faro-saveiro' }),
  ]);
  let fetches = 0;

  const summary = await runRepuestosAvenidaImageBackfill({
    store,
    fetchProductHtml: async () => {
      fetches += 1;
      return { finalUrl: productUrl, body: productHtml(productImage) };
    },
  });

  assert.equal(fetches, 1);
  assert.equal(summary.totalCandidates, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.items.find((item) => item.id === 'other-1')?.error, 'non_repuestos_avenida_source_url');
});

test('Repuestos Avenida image backfill dry-run does not write and reports pending updates', async () => {
  const store = new MemoryBackfillStore([
    row('ra-1', productUrl, { productName: 'Faro Saveiro', imageUrl: logoUrl, sourceUrl: productUrl }),
  ]);

  const summary = await runRepuestosAvenidaImageBackfill({
    store,
    fetchProductHtml: async () => ({ finalUrl: productUrl, body: productHtml(productImage, secondProductImage) }),
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.currentLogoOrPlaceholder, 1);
  assert.equal(summary.newValidImage, 1);
  assert.equal(summary.wouldUpdate, 1);
  assert.equal(summary.updated, 0);
  assert.equal(store.updates.length, 0);
});

test('Repuestos Avenida image backfill apply updates only image fields in the product payload', async () => {
  const original = row('ra-1', productUrl, {
    productName: 'Faro Saveiro',
    price: '1000',
    availability: 'in_stock',
    imageUrl: logoUrl,
    sourceUrl: productUrl,
  });
  const store = new MemoryBackfillStore([original]);

  const summary = await runRepuestosAvenidaImageBackfill({
    apply: true,
    store,
    fetchProductHtml: async () => ({ finalUrl: productUrl, body: productHtml(productImage, secondProductImage) }),
  });

  assert.equal(summary.updated, 1);
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0].id, 'ra-1');
  assert.equal(store.updates[0].product.productName, original.product.productName);
  assert.equal(store.updates[0].product.price, original.product.price);
  assert.equal(store.updates[0].product.availability, original.product.availability);
  assert.equal(store.updates[0].product.sourceUrl, original.product.sourceUrl);
  assert.equal(store.updates[0].product.imageUrl, productImage);
  assert.deepEqual(store.updates[0].product.imageUrls, [productImage, secondProductImage]);
});

test('Repuestos Avenida image backfill does not update when the extracted image is logo or placeholder only', async () => {
  const store = new MemoryBackfillStore([
    row('ra-1', productUrl, { productName: 'Faro Saveiro', imageUrl: logoUrl, sourceUrl: productUrl }),
  ]);

  const summary = await runRepuestosAvenidaImageBackfill({
    apply: true,
    store,
    fetchProductHtml: async () => ({ finalUrl: productUrl, body: productHtml(logoUrl) }),
  });

  assert.equal(summary.newValidImage, 0);
  assert.equal(summary.withoutValidImage, 1);
  assert.equal(summary.wouldUpdate, 0);
  assert.equal(summary.updated, 0);
  assert.equal(store.updates.length, 0);
});

test('Postgres Repuestos Avenida image store selects existing source URLs and updates only image JSON keys', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const postgres = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  const store = new PostgresRepuestosAvenidaImageBackfillStore(postgres as any);

  await store.findCandidates(20);
  await store.updateImages('ra-1', {
    productName: 'Faro Saveiro',
    sourceUrl: productUrl,
    imageUrl: productImage,
    imageUrls: [productImage],
    extractedAt: '2026-08-21T00:00:00.000Z',
    provider: 'domain',
  });

  assert.match(queries[0].sql, /WHERE source_url LIKE \$1 \|\| '%'/);
  assert.deepEqual(queries[0].params, ['https://repuestosavenida.com.uy/producto/', 20]);
  assert.match(queries[1].sql, /product - 'imageUrl' - 'imageUrls'/);
  assert.match(queries[1].sql, /jsonb_set/);
  assert.doesNotMatch(queries[1].sql, /INSERT INTO scraping_inventory/i);
});

class MemoryBackfillStore implements RepuestosAvenidaBackfillStore {
  readonly updates: Array<{ id: string; product: ProductRecord }> = [];

  constructor(private readonly rows: RepuestosAvenidaBackfillRow[]) {}

  async findCandidates(limit?: number): Promise<RepuestosAvenidaBackfillRow[]> {
    return typeof limit === 'number' ? this.rows.slice(0, limit) : this.rows;
  }

  async updateImages(id: string, product: ProductRecord): Promise<void> {
    this.updates.push({ id, product });
  }
}

function row(id: string, sourceUrl: string, product: Partial<ProductRecord> & Pick<ProductRecord, 'productName'>): RepuestosAvenidaBackfillRow {
  return {
    id,
    sourceUrl,
    product: {
      extractedAt: '2026-08-21T00:00:00.000Z',
      provider: 'domain',
      ...product,
    },
  };
}

function productHtml(mainImage: string, secondImage?: string): string {
  const gallery = [
    { url: mainImage, preview_url: mainImage.replace(/(\.\w+)$/, '__sm$1'), role: 'main' },
    ...(secondImage ? [{ url: secondImage, preview_url: secondImage.replace(/(\.\w+)$/, '__sm$1') }] : []),
  ];

  return `
    <html>
      <body>
        <img class="st-brand-logo" src="${logoUrl}" alt="Repuestos Avenida">
        <article
          class="storefront-product"
          data-gallery="${JSON.stringify(gallery).replace(/"/g, '&quot;')}"
        >
          <h1>Faro Saveiro</h1>
          <div class="storefront-product-price"><span>$1.000,00</span></div>
          <div class="storefront-product-stage">
            <img class="storefront-product-image" data-role="main-image" src="${mainImage}" alt="Faro Saveiro">
          </div>
        </article>
      </body>
    </html>
  `;
}
