import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida para auditoria; sin fallback');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // This file contains only SELECT statements; no writes, schema setup or migrations.
    const result = await pool.query(readFileSync('docs/sql/feyvi-audit.sql', 'utf8'));
    const results = Array.isArray(result) ? result : [result];
    console.log(JSON.stringify({ counts: results[0].rows[0], products: results[1].rows }, null, 2));
  } finally {
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
