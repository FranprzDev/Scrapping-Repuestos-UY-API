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
  priceOrder?: string;
}

export interface InventoryQueryPagination {
  limit?: number;
  offset?: number;
}

export interface InventoryStats {
  total: number;
  bySite: Array<{
    site: string;
    total: number;
  }>;
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

  async getFilteredPage(filters: InventoryQueryFilters = {}, pagination: InventoryQueryPagination = {}): Promise<StoredProduct[]> {
    const { sql, params } = buildInventoryQuery(filters, pagination);
    const rows = await this.postgresService.query<InventoryRow>(sql, params);
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

  async getStats(): Promise<InventoryStats> {
    const [total, bySite] = await Promise.all([
      this.countAll(),
      this.postgresService.query<{ site: string; total: string }>(`
        SELECT
          split_part(
            replace(replace(lower(site), 'https://', ''), 'http://', ''),
            '/',
            1
          ) AS site,
          COUNT(*)::text AS total
        FROM scraping_inventory
        GROUP BY 1
        ORDER BY COUNT(*) DESC, site ASC
      `),
    ]);

    return {
      total,
      bySite: bySite.rows.map((row) => ({
        site: row.site,
        total: Number(row.total ?? 0),
      })),
    };
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

  return undefined;
}

function normalizeKeyPart(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function buildInventoryQuery(filters: InventoryQueryFilters, pagination: InventoryQueryPagination = {}) {
  const { whereClause, params } = buildInventoryConditions(filters);
  const limit = normalizeLimit(pagination.limit);
  const offset = normalizeOffset(pagination.offset);
  const orderBy = buildOrderByClause(filters.priceOrder);
  const orderedByPrice = isPriceOrder(filters.priceOrder);

  if (limit !== undefined) {
    params.push(limit);
  }

  if (offset !== undefined) {
    params.push(offset);
  }

  return {
    sql: orderedByPrice
      ? `
      WITH inventory_rows AS (
        SELECT
          id,
          site,
          product,
          created_at,
          updated_at,
          last_seen_at,
          NULLIF(regexp_replace(COALESCE(product->>'price', ''), '[^0-9.]', '', 'g'), '')::numeric AS price_sort
        FROM scraping_inventory
        ${whereClause}
      )
      SELECT id, site, product, created_at, updated_at, last_seen_at
      FROM inventory_rows
      ORDER BY ${orderBy}
      ${limit !== undefined ? `LIMIT $${params.length - (offset !== undefined ? 1 : 0)}` : ''}
      ${offset !== undefined ? `OFFSET $${params.length}` : ''}
    `
      : `
      SELECT id, site, product, created_at, updated_at, last_seen_at
      FROM scraping_inventory
      ${whereClause}
      ORDER BY ${orderBy}
      ${limit !== undefined ? `LIMIT $${params.length - (offset !== undefined ? 1 : 0)}` : ''}
      ${offset !== undefined ? `OFFSET $${params.length}` : ''}
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
    params.push(normalizeSiteHost(filters.site.trim()));
    conditions.push(`split_part(replace(replace(lower(site), 'https://', ''), 'http://', ''), '/', 1) = $${params.length}`);
  }

  const search = filters.search?.trim();
  if (search) {
    const tokens = normalizeSearchTokens(search);
    if (tokens.length) {
      const searchableText = `
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(
                CONCAT_WS(
                  ' ',
                  COALESCE(product->>'productName', ''),
                  COALESCE(product->>'brand', ''),
                  COALESCE(product->>'category', ''),
                  COALESCE(product->>'description', '')
                )
              ),
              '[^[:alnum:]]+',
              ' ',
              'g'
            ),
            '([[:alpha:]])\\1+',
            '\\1',
            'g'
          ),
          '\\s+',
          ' ',
          'g'
        )
      `;

      for (const token of tokens) {
        params.push(`%${token.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
        conditions.push(`${searchableText} LIKE $${params.length} ESCAPE '\\'`);
      }
    }
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

function normalizeSiteHost(site: string): string {
  try {
    return new URL(site).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return site
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0];
  }
}

function buildOrderByClause(priceOrder?: string): string {
  const normalized = priceOrder?.trim().toLowerCase();
  if (normalized === 'asc') {
    return `price_sort ASC NULLS LAST, updated_at DESC`;
  }

  if (normalized === 'desc') {
    return `price_sort DESC NULLS LAST, updated_at DESC`;
  }

  return `updated_at DESC`;
}

function isPriceOrder(priceOrder?: string): boolean {
  const normalized = priceOrder?.trim().toLowerCase();
  return normalized === 'asc' || normalized === 'desc';
}

function normalizeSearchTokens(search: string): string[] {
  return search
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((token) =>
      token
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/([a-z])\1+/g, '$1')
        .trim(),
    )
    .filter((token) => token.length >= 2);
}

function normalizeLimit(value?: number): number | undefined {
  if (!Number.isFinite(value ?? NaN)) {
    return undefined;
  }

  const normalized = Math.max(1, Math.min(Math.trunc(value as number), 200));
  return normalized;
}

function normalizeOffset(value?: number): number | undefined {
  if (!Number.isFinite(value ?? NaN)) {
    return undefined;
  }

  return Math.max(0, Math.trunc(value as number));
}
