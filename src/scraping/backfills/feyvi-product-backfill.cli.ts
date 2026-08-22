import 'dotenv/config';
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

if (args.has('help')) {
  console.log([
    'Uso:',
    '  pnpm run feyvi:products:backfill -- --dry-run',
    '  pnpm run feyvi:products:backfill -- --limit=20',
    '  pnpm run feyvi:products:backfill -- --limit=5 --apply',
    '  pnpm run feyvi:products:backfill -- --apply',
    '',
    'Por defecto corre en dry-run. --apply habilita escritura real.',
  ].join('\n'));
  process.exit(0);
}

if (apply && dryRun) {
  console.error('No combines --dry-run con --apply.');
  process.exit(1);
}

const postgresService = new PostgresService();

runFeyviProductBackfill({
  apply,
  limit,
  store: new PostgresFeyviProductBackfillStore(postgresService),
  fetchProductHtml: async (sourceUrl) => {
    const response = await fetchHtml(sourceUrl);
    return {
      finalUrl: response.finalUrl,
      body: response.body,
    };
  },
})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
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
