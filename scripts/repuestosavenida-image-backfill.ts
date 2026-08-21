import 'dotenv/config';
import { PostgresService } from '../src/scraping/jobs/postgres.service';
import { fetchHtml } from '../src/scraping/domain/http-client';
import { PostgresRepuestosAvenidaImageBackfillStore } from '../src/scraping/backfills/repuestosavenida-image-backfill-postgres';
import { runRepuestosAvenidaImageBackfill } from '../src/scraping/backfills/repuestosavenida-image-backfill';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
  return [key, value];
}));

const apply = args.get('apply') === 'true';
const limit = positiveInt(args.get('limit'));

if (args.has('help')) {
  console.log([
    'Uso:',
    '  pnpm run repuestosavenida:images:backfill -- --limit=20',
    '  pnpm run repuestosavenida:images:backfill -- --limit=20 --apply',
    '',
    'Por defecto corre en dry-run. --apply habilita escritura real.',
  ].join('\n'));
  process.exit(0);
}

const postgresService = new PostgresService();

runRepuestosAvenidaImageBackfill({
  apply,
  limit,
  store: new PostgresRepuestosAvenidaImageBackfillStore(postgresService),
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
