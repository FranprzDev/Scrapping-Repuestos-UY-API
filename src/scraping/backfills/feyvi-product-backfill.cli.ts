import 'dotenv/config';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fetchHtml } from '../domain/http-client';
import { PostgresService } from '../jobs/postgres.service';
import { PostgresFeyviProductBackfillStore } from './feyvi-product-backfill-postgres';
import { runFeyviProductBackfill } from './feyvi-product-backfill';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
  return [key, value];
}));

const apply = args.get('apply') === 'true';
const dryRun = args.get('dry-run') === 'true';
const limit = positiveInt(args.get('limit'));
const batchSize = positiveInt(args.get('batch-size')) ?? 100;
const runId = args.get('run-id');
const restoreRun = args.get('restore-run');
if (restoreRun && (!apply || !/^[A-Za-z0-9_-]{1,80}$/.test(restoreRun))) throw new Error('--restore-run requiere --apply y una run-id valida');
const report = args.get('report') ?? `output/feyvi-recovery/${restoreRun ? `${restoreRun}-restored` : runId ?? 'dry-run'}.json`;
if (runId && !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error('run-id invalido');
for (const key of ['limit', 'batch-size']) {
  if (args.has(key) && !positiveInt(args.get(key))) throw new Error(`${key} debe ser un entero positivo`);
}

if (args.has('help')) {
  console.log([
    'Uso:',
    '  pnpm run feyvi:products:backfill -- --dry-run',
    '  pnpm run feyvi:products:backfill -- --limit=20',
    '  pnpm run feyvi:products:backfill -- --limit=5 --apply --run-id=feyvi-pilot',
    '  pnpm run feyvi:products:backfill -- --apply --run-id=feyvi-20261011 --all',
    '  Opciones: --batch-size=100 --report=output/feyvi-recovery/report.json',
    '',
    'Por defecto corre en dry-run. --apply habilita escritura real.',
  ].join('\n'));
  process.exit(0);
}

if (apply && dryRun) {
  console.error('No combines --dry-run con --apply.');
  process.exit(1);
}

if (apply && !restoreRun && (!runId || (!limit && args.get('all') !== 'true'))) {
  console.error('--apply requiere --run-id y --limit=N o --all. La misma run-id reanuda sin repetir cambios.');
  process.exit(1);
}
const postgresService = new PostgresService();

(restoreRun
  ? postgresService.query('SELECT feyvi_restore_run($1) AS restored', [restoreRun]).then(result => ({ restored: result.rows[0].restored, errors: 0 }))
  : runFeyviProductBackfill({
  apply,
  limit,
  batchSize,
  runId,
  store: new PostgresFeyviProductBackfillStore(postgresService),
  fetchProductHtml: async (sourceUrl) => {
    const response = await fetchHtml(sourceUrl);
    return {
      statusCode: response.statusCode,
      finalUrl: response.finalUrl,
      body: response.body,
    };
  },
}))
  .then(async (summary) => {
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(`${report}.tmp`, JSON.stringify(summary, null, 2));
    await rename(`${report}.tmp`, report);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.errors) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await postgresService.onModuleDestroy();
  });

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
