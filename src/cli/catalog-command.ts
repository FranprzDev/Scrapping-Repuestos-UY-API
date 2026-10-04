import { getCatalogSite } from '../scraping/sites/catalog-sites';
import { runCatalogPipeline } from '../scraping/sites/catalog-pipeline';
import type { CatalogRunMode } from '../scraping/sites/types';

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=', 2);
  return [key, value];
}));
const mode = (args.get('mode') ?? process.env.CATALOG_MODE) as CatalogRunMode;
const siteId = args.get('site');

if (!siteId || !mode) {
  console.error('Uso: pnpm run catalog:audit --site=romy --max-pages=2 --max-products=10');
  process.exit(2);
}

const site = getCatalogSite(siteId);
if (!site) {
  console.error(`Sitio no registrado: ${siteId}`);
  process.exit(2);
}

runCatalogPipeline({
  site,
  mode,
  maxPages: positiveInt(args.get('max-pages')),
  maxProducts: positiveInt(args.get('max-products')),
})
  .then((report) => console.log(JSON.stringify(report, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
