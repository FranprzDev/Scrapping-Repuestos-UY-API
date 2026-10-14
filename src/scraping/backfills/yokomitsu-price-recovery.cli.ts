import 'dotenv/config';
import { Client } from 'pg';
import { YokomitsuCookieJarHttpClient } from '../domain/yokomitsu-http-client';
import { authenticateYokomitsuHttpSession, isYokomitsuSessionExpiredResponse } from '../domain/yokomitsu-auth';
import { isYokomitsuDetailUrl, verifiedYokomitsuDetailProduct } from '../domain/yokomitsu-pricing';

type Row = { id: string; source_url: string; sku: string | null; price: string | null };
type ResultStatus = 'updated' | 'unchanged' | 'unverified' | 'error';
const RUN_ID = 'yokomitsu-prices-20261013';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Shared verification with the daily scraper. */
export function verifiedDetailProduct(html: string, url: string, expectedSku: string | null): { sku: string; price: string } | undefined {
  return verifiedYokomitsuDetailProduct(html, url, expectedSku);
}

export function verifiedDetailPrice(html: string, url: string, expectedSku: string | null): string | undefined {
  return verifiedDetailProduct(html, url, expectedSku)?.price;
}

async function main() {
  if (!process.env.DATABASE_URL || !process.env.YOKOMITSU_USERNAME || !process.env.YOKOMITSU_PASSWORD)
    throw new Error('Missing DATABASE_URL / YOKOMITSU_USERNAME / YOKOMITSU_PASSWORD');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const client = new YokomitsuCookieJarHttpClient();
  let hasLock = false;
  let stopRequested = false;
  process.on('SIGINT', () => { stopRequested = true; console.log('SIGINT: stopping after current item'); });
  process.on('SIGTERM', () => { stopRequested = true; console.log('SIGTERM: stopping after current item'); });
  const summary: Record<string, number> = { scanned: 0, updated: 0, unchanged: 0, recoveredSku: 0, unverified: 0, error: 0, skippedPreviouslyCompleted: 0 };
  try {
    await db.connect();
    // Prevent concurrent recovery runs against the same database.
    const lock = await db.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(7183011201) AS locked');
    if (!lock.rows[0]?.locked) throw new Error('Another Yokomitsu price recovery is running');
    hasLock = true;
    await db.query(`
      CREATE TABLE IF NOT EXISTS yokomitsu_price_recovery_progress (
        run_id text NOT NULL,
        inventory_id text NOT NULL,
        source_url text NOT NULL,
        status text NOT NULL,
        previous_price text,
        verified_price text,
        reason text,
        checked_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (run_id, inventory_id)
      )`);
    const rows = await db.query<Row>(`
      SELECT id, source_url, product->>'sku' AS sku, product->>'price' AS price
      FROM scraping_inventory
      WHERE source_url ILIKE '%yokomitsuparts.com.uy%'
      ORDER BY id`);
    console.log('TOTAL', rows.rows.length, 'run', RUN_ID);
    const auth = async () => {
      await client.clearSession();
      const result = await authenticateYokomitsuHttpSession(client, {
        username: process.env.YOKOMITSU_USERNAME!,
        password: process.env.YOKOMITSU_PASSWORD!,
      });
      if (!result.authenticated) throw new Error('Yokomitsu authentication failed: ' + (result.error ?? 'unknown'));
    };
    await auth();
    const completed = await db.query<{ inventory_id: string }>(`
      SELECT inventory_id FROM yokomitsu_price_recovery_progress
      WHERE run_id = $1 AND status IN ('updated', 'unchanged')`, [RUN_ID]);
    const done = new Set(completed.rows.map((r) => r.inventory_id));
    summary.skippedPreviouslyCompleted = done.size;
    for (const row of rows.rows) {
      if (stopRequested) break;
      if (done.has(row.id)) continue;
      let status: ResultStatus = 'unverified', reason: string | null = null, verifiedPrice: string | null = null;
      try {
        if (!isYokomitsuDetailUrl(row.source_url)) {
          reason = 'invalid-detail-url';
        } else {
          let response = await client.get(row.source_url, { accept: 'text/html,application/xhtml+xml' });
          if (isYokomitsuSessionExpiredResponse(response)) {
            await auth();
            response = await client.get(row.source_url, { accept: 'text/html,application/xhtml+xml' });
          }
          if (isYokomitsuSessionExpiredResponse(response)) throw new Error('session-expired-after-reauthentication');
          if (response.status !== 200) {
            reason = 'http-' + response.status;
          } else {
            const detail = verifiedDetailProduct(response.body, row.source_url, row.sku);
            verifiedPrice = detail?.price ?? null;
            if (!detail) reason = 'detail-sku-or-price-not-verifiable';
            else {
              const recoveringSku = !row.sku?.trim();
              // Prevent attaching a supplier SKU already claimed by a different product URL.
              const collision = recoveringSku
                ? await db.query<{ id: string }>(`
                  SELECT id FROM scraping_inventory
                  WHERE source_url ILIKE '%yokomitsuparts.com.uy%'
                    AND product->>'sku' = $1
                    AND id <> $2
                    AND source_url <> $3 LIMIT 1`, [detail.sku, row.id, row.source_url])
                : null;
              if (collision?.rows.length) {
                reason = 'sku-already-used-by-another-product';
              } else if (!recoveringSku && Number(detail.price) === Number(row.price)) {
                status = 'unchanged';
              } else {
                const update = await db.query(`
                  UPDATE scraping_inventory
                  SET product = jsonb_set(
                        jsonb_set(product, '{price}', to_jsonb($1::text), true),
                        '{sku}', to_jsonb($2::text), true
                      ), updated_at = NOW()
                  WHERE id = $3 AND source_url = $4
                    AND NULLIF(trim(product->>'sku'), '') IS NOT DISTINCT FROM $5
                    AND product->>'price' IS NOT DISTINCT FROM $6
                  RETURNING id`,
                  [detail.price, detail.sku, row.id, row.source_url, row.sku?.trim() || null, row.price]);
                if (update.rowCount === 1) {
                  status = 'updated';
                  if (recoveringSku) summary.recoveredSku++;
                } else {
                  status = 'error'; reason = 'concurrent-product-modification';
                }
              }
            }
          }
        }
      } catch (error) { status = 'error'; reason = error instanceof Error ? error.message.slice(0, 160) : 'unexpected-error'; }
      await db.query(`
        INSERT INTO yokomitsu_price_recovery_progress
          (run_id,inventory_id,source_url,status,previous_price,verified_price,reason,checked_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT(run_id,inventory_id) DO UPDATE SET
          status=EXCLUDED.status, previous_price=EXCLUDED.previous_price,
          verified_price=EXCLUDED.verified_price, reason=EXCLUDED.reason,
          checked_at=EXCLUDED.checked_at`,
        [RUN_ID, row.id, row.source_url, status, row.price, verifiedPrice, reason]);
      summary[status]++;
      summary.scanned++;
      if (summary.scanned % 100 === 0) console.log('AVANCE', JSON.stringify(summary));
      // Respect supplier capacity. Any interruption can be resumed via the same command.
      await sleep(350);
    }
    console.log('RESULTADO', JSON.stringify(summary));
    const issues = await db.query<{ reason: string; count: string }>(`
      SELECT coalesce(reason,'none') AS reason, COUNT(*)::text AS count
      FROM yokomitsu_price_recovery_progress WHERE run_id=$1
        AND status IN ('unverified','error')
      GROUP BY reason ORDER BY COUNT(*) DESC LIMIT 15`, [RUN_ID]);
    console.table(issues.rows);
  } finally {
    await client.clearSession().catch(() => undefined);
    if (hasLock) await db.query('SELECT pg_advisory_unlock(7183011201)').catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}
if (require.main === module) void main().catch((error) => {
  console.error('ERROR FATAL', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
