import 'dotenv/config';
import { fetchHtml } from '../domain/http-client';
import { PostgresService } from '../jobs/postgres.service';
import { PostgresFamilcarCymacoImageBackfillStore } from './familcar-cymaco-image-backfill-postgres';
import { parseFamilcarCymacoBackfillSite, runFamilcarCymacoImageBackfill } from './familcar-cymaco-image-backfill';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
  return [key, value];
}));

const apply = args.get('apply') === 'true';
const limit = positiveInt(args.get('limit'));

if (args.has('help')) {
  console.log([
    'Uso:',
    '  pnpm run familcar-cymaco:images:backfill -- --limit=20',
    '  pnpm run familcar-cymaco:images:backfill -- --site=familcar',
    '  pnpm run familcar-cymaco:images:backfill -- --site=cymaco --limit=5',
    '  pnpm run familcar-cymaco:images:backfill -- --limit=20 --apply',
    '',
    'Por defecto corre en dry-run. --apply habilita escritura real.',
  ].join('\n'));
  process.exit(0);
}

const site = parseFamilcarCymacoBackfillSite(args.get('site'));
const postgresService = new PostgresService();

runFamilcarCymacoImageBackfill({
  apply,
  limit,
  site,
  store: new PostgresFamilcarCymacoImageBackfillStore(postgresService),
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
