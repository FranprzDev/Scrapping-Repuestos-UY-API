import { getCatalogSite } from '../src/scraping/sites/catalog-sites';
import { runCatalogPipeline } from '../src/scraping/sites/catalog-pipeline';
import { parseCatalogCommandArgs } from '../src/scraping/sites/catalog-command-args';

const { mode, siteId, maxPages, maxProducts } = parseCatalogCommandArgs(process.argv.slice(2));

if (!siteId || !mode) {
  console.error(`Uso: pnpm run catalog:${mode} --site=container`);
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
  maxPages,
  maxProducts,
})
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

