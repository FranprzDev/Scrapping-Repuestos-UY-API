import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CatalogPlatform } from './types';

export interface CreateSiteOptions {
  id: string;
  platform: CatalogPlatform;
  rootDir?: string;
}

export async function createSiteScaffold(options: CreateSiteOptions): Promise<string[]> {
  const rootDir = options.rootDir ?? process.cwd();
  const id = normalizeId(options.id);
  const className = toPascalCase(id);
  const sitePath = path.join(rootDir, 'src', 'scraping', 'sites', 'definitions', `${id}.site.ts`);
  const adapterPath = path.join(rootDir, 'src', 'scraping', 'sites', 'definitions', `${id}.adapter.ts`);
  const testPath = path.join(rootDir, 'src', 'scraping', 'sites', 'definitions', `${id}.site.test.ts`);
  const fixtureDir = path.join(rootDir, 'src', 'scraping', 'sites', 'definitions', 'fixtures', id);
  const generatedPath = path.join(rootDir, 'src', 'scraping', 'sites', 'generated-sites.ts');

  await mkdir(path.dirname(sitePath), { recursive: true });
  await mkdir(fixtureDir, { recursive: true });

  await writeFile(sitePath, siteFile(id, options.platform));
  await writeFile(adapterPath, adapterFile(className, options.platform));
  await writeFile(testPath, testFile(id));
  await writeFile(path.join(fixtureDir, 'listing.html'), fixtureFile(id));
  await updateGeneratedSites(generatedPath, id);

  return [sitePath, adapterPath, testPath, fixtureDir, generatedPath];
}

async function updateGeneratedSites(generatedPath: string, id: string): Promise<void> {
  let current = '';
  try {
    current = await readFile(generatedPath, 'utf8');
  } catch {
    current = "import type { CatalogSiteConfig } from './types';\n\nexport const GENERATED_CATALOG_SITES: CatalogSiteConfig[] = [];\n";
  }
  const importName = `${toCamelCase(id)}Site`;
  if (current.includes(`./definitions/${id}.site`)) {
    return;
  }
  const imports = current.replace(/^import type \{ CatalogSiteConfig \} from '\.\/types';\n/, '').trim();
  const existingItems = Array.from(current.matchAll(/\b([a-z][a-zA-Z0-9]*)Site\b/g)).map((match) => match[1] + 'Site');
  const uniqueItems = Array.from(new Set([...existingItems, importName]));
  const next = [
    "import type { CatalogSiteConfig } from './types';",
    `import { ${importName} } from './definitions/${id}.site';`,
    imports
      .split('\n')
      .filter((line) => line.startsWith('import ') && !line.includes(`./definitions/${id}.site`))
      .join('\n'),
    '',
    `export const GENERATED_CATALOG_SITES: CatalogSiteConfig[] = [${uniqueItems.join(', ')}];`,
    '',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
  await mkdir(path.dirname(generatedPath), { recursive: true });
  await writeFile(generatedPath, next);
}

function siteFile(id: string, platform: CatalogPlatform): string {
  return `import type { CatalogSiteConfig } from '../types';

export const ${toCamelCase(id)}Site: CatalogSiteConfig = {
  id: '${id}',
  label: '${toTitle(id)}',
  hostname: '${id}.example.com',
  seedUrls: ['https://${id}.example.com/'],
  platform: '${platform}',
  authentication: { type: 'none' },
  productUrlPatterns: [/\\/(?:producto|product|articulo|catalogo)[^?#]+/i],
  categoryUrlPatterns: [/\\/(?:productos|products|categoria|category|catalogo)(?:\\/|\\?|$)/i],
  paginationStrategy: { type: 'next-link' },
  priceLocale: 'es-UY',
  preserveOutOfStock: true,
  concurrency: 2,
  requestDelay: 500,
  enabled: false,
};
`;
}

function adapterFile(className: string, platform: CatalogPlatform): string {
  return `import { ${baseAdapter(platform)} } from '../adapters';

export class ${className}Adapter extends ${baseAdapter(platform)} {
  // Extender aqui selectors, APIs o reglas especificas del sitio.
}
`;
}

function testFile(id: string): string {
  return `import assert from 'node:assert/strict';
import test from 'node:test';
import { ${toCamelCase(id)}Site } from './${id}.site';

test('${id} declara la configuracion minima de catalogo', () => {
  assert.equal(${toCamelCase(id)}Site.id, '${id}');
  assert.equal(${toCamelCase(id)}Site.enabled, false);
  assert.equal(${toCamelCase(id)}Site.concurrency, 2);
});
`;
}

function fixtureFile(id: string): string {
  return `<!doctype html>
<html>
  <body>
    <a href="/producto/${id}-sample">Producto de ejemplo</a>
  </body>
</html>
`;
}

function baseAdapter(platform: CatalogPlatform): string {
  const adapters: Record<CatalogPlatform, string> = {
    woocommerce: 'WooCommerceAdapter',
    shopify: 'ShopifyAdapter',
    fenicio: 'FenicioAdapter',
    'generic-html': 'GenericHtmlPaginationAdapter',
    'json-api': 'JsonApiAdapter',
    'mercado-libre-api': 'MercadoLibreApiAdapter',
  };
  return adapters[platform];
}

function normalizeId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id) {
    throw new Error('Site id is required');
  }
  return id;
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal.slice(0, 1).toLowerCase() + pascal.slice(1);
}

function toPascalCase(value: string): string {
  return value.split('-').filter(Boolean).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join('');
}

function toTitle(value: string): string {
  return value.split('-').filter(Boolean).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ');
}
