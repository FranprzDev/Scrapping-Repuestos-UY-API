import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type QueryConfig, type QueryResult, type QueryResultRow } from 'pg';
import { VEHICLE_BRANDS } from '../domain/vehicle-brands';

@Injectable()
export class PostgresService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const connectionString = resolveConnectionString();
    if (!connectionString) {
      throw new Error('DATABASE_URL no configurada');
    }

    this.pool = new Pool({
      connectionString,
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
    timeoutMs?: number,
  ): Promise<QueryResult<T>> {
    const queryConfig: QueryConfig & { query_timeout?: number } = {
      text: sql,
      values: params,
    };

    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      queryConfig.query_timeout = timeoutMs;
    }

    return this.pool.query<T>(queryConfig);
  }

  async ensureJobsTable(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS scraping_jobs (
        id UUID PRIMARY KEY,
        task TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL,
        provider TEXT NULL,
        progress JSONB NULL,
        result JSONB NULL,
        error TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.query(`ALTER TABLE scraping_jobs ADD COLUMN IF NOT EXISTS progress JSONB NULL;`);

    await this.query(`CREATE INDEX IF NOT EXISTS scraping_jobs_status_created_idx ON scraping_jobs(status, created_at);`);
  }

  async ensureCatalogTables(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS scraping_inventory (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        source_url TEXT NOT NULL,
        product JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS scraping_inventory_site_idx ON scraping_inventory(site);`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS vehicle_brands (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS vehicle_brand_aliases (
        brand_id TEXT NOT NULL REFERENCES vehicle_brands(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        PRIMARY KEY (brand_id, alias)
      );
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS scraping_inventory_vehicle_brands (
        inventory_id TEXT NOT NULL REFERENCES scraping_inventory(id) ON DELETE CASCADE,
        brand_id TEXT NOT NULL REFERENCES vehicle_brands(id),
        confidence TEXT NOT NULL,
        evidence TEXT NULL,
        PRIMARY KEY (inventory_id, brand_id)
      );
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS scraping_inventory_vehicle_brands_brand_idx
      ON scraping_inventory_vehicle_brands (brand_id, inventory_id);
    `);

    await this.seedVehicleBrands();

    await this.query(`
      CREATE TABLE IF NOT EXISTS scraping_runs (
        id UUID PRIMARY KEY,
        requested_at TIMESTAMPTZ NOT NULL,
        strategy TEXT NOT NULL,
        sites_processed INT NOT NULL,
        inventory_size INT NOT NULL,
        summary JSONB NOT NULL
      );
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS scraping_runs_requested_at_idx ON scraping_runs(requested_at DESC);`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS scraping_run_sites (
        run_id UUID NOT NULL REFERENCES scraping_runs(id) ON DELETE CASCADE,
        site TEXT NOT NULL,
        status TEXT NOT NULL,
        payload JSONB NOT NULL,
        PRIMARY KEY (run_id, site)
      );
    `);
  }

  private async seedVehicleBrands(): Promise<void> {
    const brandIds = VEHICLE_BRANDS.map((brand) => brand.id);
    const brandLabels = VEHICLE_BRANDS.map((brand) => brand.label);
    await this.query(
      `
      INSERT INTO vehicle_brands (id, label, active)
      SELECT item.id, item.label, TRUE
      FROM unnest($1::text[], $2::text[]) AS item(id, label)
      ON CONFLICT (id)
      DO UPDATE SET label = EXCLUDED.label,
                    active = TRUE
      `,
      [brandIds, brandLabels],
    );

    const aliasBrandIds = VEHICLE_BRANDS.flatMap((brand) => brand.aliases.map(() => brand.id));
    const aliases = VEHICLE_BRANDS.flatMap((brand) => brand.aliases.map((alias) => normalizeAlias(alias)));
    await this.query(
      `
      INSERT INTO vehicle_brand_aliases (brand_id, alias)
      SELECT item.brand_id, item.alias
      FROM unnest($1::text[], $2::text[]) AS item(brand_id, alias)
      ON CONFLICT (brand_id, alias) DO NOTHING
      `,
      [aliasBrandIds, aliases],
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

function normalizeAlias(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveConnectionString(): string | undefined {
  const configured = process.env.DATABASE_URL?.trim();
  if (configured) {
    return configured;
  }

  if ((process.env.NODE_ENV ?? 'development') !== 'production') {
    return 'postgresql://postgres:postgres@localhost:5433/repuestos_uy';
  }

  return undefined;
}
