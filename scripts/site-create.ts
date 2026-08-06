import { createSiteScaffold } from '../src/scraping/sites/site-generator';
import type { CatalogPlatform } from '../src/scraping/sites/types';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
  return [key, value];
}));

const id = args.get('id');
const platform = args.get('platform') as CatalogPlatform | undefined;

if (!id || !platform) {
  console.error('Uso: pnpm run site:create --id=container --platform=generic-html');
  process.exit(2);
}

createSiteScaffold({ id, platform })
  .then((files) => {
    console.log(JSON.stringify({ created: files }, null, 2));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
