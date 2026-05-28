import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

@Injectable()
export class PostgresService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL no configurada');
    }

    this.pool = new Pool({
      connectionString,
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  async ensureJobsTable(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS scraping_jobs (
        id UUID PRIMARY KEY,
        task TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL,
        provider TEXT NULL,
        result JSONB NULL,
        error TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.query(`CREATE INDEX IF NOT EXISTS scraping_jobs_status_created_idx ON scraping_jobs(status, created_at);`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
