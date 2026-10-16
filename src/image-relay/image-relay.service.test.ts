import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ImageRelayService } from './image-relay.service';

test('no crea trabajos de imagen si falta el inventario y no propaga el fallo al catálogo', async () => {
  const queries: string[] = [];
  const previousEnabled = process.env.IMAGE_RELAY_ENABLED;
  const previousAllowed = process.env.IMAGE_RELAY_ALLOWED_SITES;
  process.env.IMAGE_RELAY_ENABLED = 'true';
  process.env.IMAGE_RELAY_ALLOWED_SITES = '*';

  try {
    const service = new ImageRelayService({
      async query(sql: string) {
        queries.push(sql);
        return { rows: [], rowCount: 0 } as never;
      },
    } as never);

    const result = await service.enqueueForInventory(
      'url|https://acesur.uy/detalle-producto?articulo=missing',
      'https://acesur.uy/escritorio/ofertas/INTERNET',
      { imageUrl: 'https://acesur.uy/fotos/missing.jpg' },
    );

    assert.equal(result, 1);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /WHERE EXISTS\s*\(SELECT 1 FROM scraping_inventory WHERE id = \$1\)/i);
  } finally {
    if (previousEnabled === undefined) delete process.env.IMAGE_RELAY_ENABLED;
    else process.env.IMAGE_RELAY_ENABLED = previousEnabled;
    if (previousAllowed === undefined) delete process.env.IMAGE_RELAY_ALLOWED_SITES;
    else process.env.IMAGE_RELAY_ALLOWED_SITES = previousAllowed;
  }
});

test('tolera una violación FK residual de imagen sin abortar el scraping', async () => {
  const previousEnabled = process.env.IMAGE_RELAY_ENABLED;
  const previousAllowed = process.env.IMAGE_RELAY_ALLOWED_SITES;
  process.env.IMAGE_RELAY_ENABLED = 'true';
  process.env.IMAGE_RELAY_ALLOWED_SITES = '*';

  try {
    const service = new ImageRelayService({
      async query() {
        const error = Object.assign(new Error('foreign key'), { code: '23503' });
        throw error;
      },
    } as never);

    await assert.doesNotReject(() => service.enqueueForInventory(
      'url|https://www.grfrenos.uy/producto/missing',
      'https://www.grfrenos.uy/home/',
      { imageUrl: 'https://www.grfrenos.uy/images/missing.jpg' },
    ));
  } finally {
    if (previousEnabled === undefined) delete process.env.IMAGE_RELAY_ENABLED;
    else process.env.IMAGE_RELAY_ENABLED = previousEnabled;
    if (previousAllowed === undefined) delete process.env.IMAGE_RELAY_ALLOWED_SITES;
    else process.env.IMAGE_RELAY_ALLOWED_SITES = previousAllowed;
  }
});

