import type { CatalogRunMode } from './types';

export interface CatalogCommandArgs {
  mode?: CatalogRunMode;
  siteId?: string;
  maxPages?: number;
  maxProducts?: number;
}

export function parseCatalogCommandArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CatalogCommandArgs {
  const args = new Map(argv.map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
    return [key, value];
  }));

  return {
    mode: (args.get('mode') ?? env.CATALOG_MODE) as CatalogRunMode | undefined,
    siteId: args.get('site'),
    maxPages: positiveInt(args.get('max-pages')),
    maxProducts: positiveInt(args.get('max-products')),
  };
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
