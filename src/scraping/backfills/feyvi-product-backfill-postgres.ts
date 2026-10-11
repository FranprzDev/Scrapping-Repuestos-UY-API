import { ProductRecord } from '../interfaces/scraping.types';
import { PostgresService } from '../jobs/postgres.service';
import { FeyviBackfillRow, FeyviBackfillStore, FeyviProductBackfillItem } from './feyvi-product-backfill';

type CandidateRow = {
  id: string;
  source_url: string;
  product: ProductRecord;
};

export class PostgresFeyviProductBackfillStore implements FeyviBackfillStore {
  constructor(private readonly postgresService: PostgresService) {}

  async findCandidates(limit = 100, afterId?: string): Promise<FeyviBackfillRow[]> {
    const result = await this.postgresService.query<CandidateRow>(
      `SELECT id, source_url, product FROM scraping_inventory
       WHERE source_url ~* '^https?://(www\\.)?feyvi\\.com\\.uy/repuestos/([^/]+/){2}[^/?#]+/?$'
         AND ($2::text IS NULL OR id > $2)
       ORDER BY id ASC LIMIT $1`, [limit, afterId ?? null],
    );
    return result.rows.map((row) => ({ id: row.id, sourceUrl: row.source_url, product: row.product }));
  }

  async updateProductFields(id: string, product: ProductRecord, previous?: ProductRecord, runId?: string): Promise<void> {
    if (!previous || !runId) throw new Error('expected product and run-id required for backed-up recovery');
    await this.postgresService.query('SELECT feyvi_apply_patch($1, $2::jsonb, $3::jsonb, $4)',
      [id, JSON.stringify(previous), JSON.stringify(product), runId]);
  }

  async completedIds(runId: string): Promise<string[]> {
    const result = await this.postgresService.query<{ inventory_id: string }>(
      `SELECT inventory_id FROM feyvi_recovery_backups WHERE run_id = $1
       UNION SELECT inventory_id FROM feyvi_recovery_results
       WHERE run_id = $1 AND apply AND NOT (result ? 'error')`, [runId]);
    return result.rows.map((row) => row.inventory_id);
  }

  async recordResult(runId: string, item: FeyviProductBackfillItem, apply: boolean): Promise<void> {
    if (!apply) return; // A dry-run never writes even progress/error records to the database.
    await this.postgresService.query(
      `WITH event AS (
         INSERT INTO feyvi_recovery_events(run_id,inventory_id,result) VALUES($1,$2,$3::jsonb) RETURNING id
       ) INSERT INTO feyvi_recovery_results(run_id,inventory_id,apply,result) VALUES($1,$2,true,$3::jsonb)
       ON CONFLICT(run_id,inventory_id,apply) DO UPDATE SET result = EXCLUDED.result, updated_at = NOW()`,
      [runId, item.id, JSON.stringify(item)]);
  }
}
