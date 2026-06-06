import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ProductRecord } from '../interfaces/scraping.types';
import { PostgresService } from '../jobs/postgres.service';

export interface StoredProduct extends ProductRecord {
  id: string;
  site: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

type InventoryRow = {
  id: string;
  site: string;
  product: ProductRecord;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
};

export interface InventoryQueryFilters {
  site?: string;
  search?: string;
  priceState?: string;
  availability?: string;
}

@Injectable()
export class InventoryStoreService implements OnModuleInit {
  private readonly upsertChunkSize = 100;

  constructor(@Inject(PostgresService) private readonly postgresService: PostgresService) {}

  async onModuleInit(): Promise<void> {
    await this.postgresService.ensureCatalogTables();
  }

  async upsertSiteProducts(site: string, products: ProductRecord[], runAt: string) {
    let created = 0;
    let updated = 0;

    const payload = products
      .map((product) => {
        const key = buildProductKey(site, product);
        if (!key) {
          return undefined;
        }

        return {
          id: key,
          site,
          product: JSON.stringify(product),
        };
      })
      .filter((item): item is { id: string; site: string; product: string } => Boolean(item));

    for (let index = 0; index < payload.length; index += this.upsertChunkSize) {
      const chunk = payload.slice(index, index + this.upsertChunkSize);
      const upserted = await this.postgresService.query<{ created: boolean }>(
        `
        INSERT INTO scraping_inventory (id, site, product, created_at, updated_at, last_seen_at)
        SELECT item.id, item.site, item.product::jsonb, $1::timestamptz, $1::timestamptz, $1::timestamptz
        FROM unnest($2::text[], $3::text[], $4::text[]) AS item(id, site, product)
        ON CONFLICT (id)
        DO UPDATE SET
          site = EXCLUDED.site,
          product = EXCLUDED.product,
          updated_at = EXCLUDED.updated_at,
          last_seen_at = EXCLUDED.last_seen_at
        RETURNING (xmax = 0) AS created
        `,
        [runAt, chunk.map((item) => item.id), chunk.map((item) => item.site), chunk.map((item) => item.product)],
      );

      for (const row of upserted.rows) {
        if (row.created) {
          created += 1;
        } else {
          updated += 1;
        }
      }
    }

    const totalForSite = await this.countBySite(site);
    return { created, updated, totalForSite };
  }

  async getAll(): Promise<StoredProduct[]> {
    return this.getFiltered();
  }

  async getBySite(site: string): Promise<StoredProduct[]> {
    return this.getFiltered({ site });
  }

  async getFiltered(filters: InventoryQueryFilters = {}): Promise<StoredProduct[]> {
    const { sql, params } = buildInventoryQuery(filters);
    const rows = await this.postgresService.query<InventoryRow>(
      sql,
      params,
    );
    return rows.rows.map(mapInventoryRow);
  }

  async countAll(): Promise<number> {
    const result = await this.postgresService.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM scraping_inventory');
    return Number(result.rows[0]?.total ?? 0);
  }

  async countBySite(site: string): Promise<number> {
    const result = await this.postgresService.query<{ total: string }>(
      'SELECT COUNT(*)::text AS total FROM scraping_inventory WHERE site = $1',
      [site],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async countFiltered(filters: InventoryQueryFilters = {}): Promise<number> {
    const { sql, params } = buildInventoryCountQuery(filters);
    const result = await this.postgresService.query<{ total: string }>(sql, params);
    return Number(result.rows[0]?.total ?? 0);
  }
}

function mapInventoryRow(row: InventoryRow): StoredProduct {
  return {
    ...row.product,
    id: row.id,
    site: row.site,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function buildProductKey(site: string, product: ProductRecord): string | undefined {
  const sourceUrl = normalizeKeyPart(product.sourceUrl);
  if (sourceUrl) {
    return `${site}|url|${sourceUrl}`;
  }

  const sku = normalizeKeyPart(product.sku);
  if (sku) {
    return `${site}|sku|${sku}`;
  }

  const productName = normalizeKeyPart(product.productName);
  if (!productName) {
    return undefined;
  }

  const brand = normalizeKeyPart(product.brand) ?? 'no-brand';
  return `${site}|name|${productName}|${brand}`;
}

function normalizeKeyPart(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function buildInventoryQuery(filters: InventoryQueryFilters) {
  const { whereClause, params } = buildInventoryConditions(filters);

  return {
    sql: `
      SELECT id, site, product, created_at, updated_at, last_seen_at
      FROM scraping_inventory
      ${whereClause}
      ORDER BY updated_at DESC
    `,
    params,
  };
}

function buildInventoryCountQuery(filters: InventoryQueryFilters) {
  const { whereClause, params } = buildInventoryConditions(filters);

  return {
    sql: `
      SELECT COUNT(*)::text AS total
      FROM scraping_inventory
      ${whereClause}
    `,
    params,
  };
}

function buildInventoryConditions(filters: InventoryQueryFilters) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.site?.trim()) {
    params.push(filters.site.trim());
    conditions.push(`site = $${params.length}`);
  }

  const search = filters.search?.trim();
  if (search) {
    const pattern = `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    params.push(pattern);
    const index = params.length;
    conditions.push(`
      (
        COALESCE(product->>'productName', '') ILIKE $${index} ESCAPE '\\'
        OR COALESCE(product->>'brand', '') ILIKE $${index} ESCAPE '\\'
        OR COALESCE(product->>'category', '') ILIKE $${index} ESCAPE '\\'
        OR COALESCE(product->>'description', '') ILIKE $${index} ESCAPE '\\'
      )
    `);
  }

  const priceState = normalizeState(filters.priceState);
  if (priceState === 'with-price') {
    conditions.push(`COALESCE(NULLIF(BTRIM(product->>'price'), ''), '') <> ''`);
  } else if (priceState === 'without-price') {
    conditions.push(`COALESCE(NULLIF(BTRIM(product->>'price'), ''), '') = ''`);
  }

  const availability = normalizeState(filters.availability);
  if (availability === 'available') {
    conditions.push(`
      LOWER(COALESCE(product->>'availability', '')) IN ('in_stock', 'in stock', 'available', 'available now')
    `);
  } else if (availability === 'unavailable') {
    conditions.push(`
      LOWER(COALESCE(product->>'availability', '')) IN ('out_of_stock', 'out of stock', 'unavailable', 'agotado', 'sin stock')
    `);
  } else if (availability === 'unknown') {
    conditions.push(`
      COALESCE(NULLIF(BTRIM(LOWER(product->>'availability')), ''), 'unknown') = 'unknown'
    `);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  return { whereClause, params };
}

function normalizeState(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}
