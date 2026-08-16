import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchHtml } from '../domain/http-client';
import { createCatalogAdapter } from './adapters';
import { auditCounts } from './adapters/base.adapter';
import type { CatalogAuditReport, CatalogPipelineOptions } from './types';

export async function runCatalogPipeline(options: CatalogPipelineOptions): Promise<CatalogAuditReport> {
  const adapter = createCatalogAdapter(options.site.platform);
  const discoveryOutputRoot = options.outputRoot ?? (options.mode === 'discover' ? 'tmp/catalog-discovery' : 'tmp/catalog-audit');
  const context = {
    site: options.site,
    maxPages: options.maxPages,
    signal: options.signal,
    fetch: async (url: string, init?: { headers?: Record<string, string> }) => {
      const response = await fetchHtml(url, 5, { headers: init?.headers, signal: options.signal });
      if (response.statusCode === 429 || response.statusCode >= 500) {
        throw Object.assign(new Error(`HTTP ${response.statusCode}`), { statusCode: response.statusCode });
      }
      return response;
    },
  };

  const discovery = await adapter.discover(context);
  if (options.maxPages !== undefined) {
    discovery.pages = discovery.pages.slice(0, options.maxPages);
    discovery.discoveredUrls = discovery.pages.flatMap((page) => page.productUrls);
    discovery.uniqueUrls = Array.from(new Set(discovery.discoveredUrls));
  }

  await mkdir(discoveryOutputRoot, { recursive: true });
  const discoveryPath = path.join(discoveryOutputRoot, `${options.site.id}.json`);
  await writeFile(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`);

  if (options.mode === 'discover') {
    return { ...emptyAudit(options), ...auditCounts(options.site, options.mode, discovery, { siteId: options.site.id, products: [], rejected: [], errors: [] }, { products: [], duplicates: [] }, { products: [], rejected: [] }), outputPath: discoveryPath };
  }

  const urls = discovery.uniqueUrls.slice(0, options.maxProducts ?? discovery.uniqueUrls.length);
  const extraction = await adapter.extract(context, urls);
  const normalization = adapter.normalize(options.site, extraction.products);
  const validation = adapter.validate(options.site, normalization.products);
  const report = auditCounts(options.site, options.mode, discovery, extraction, normalization, validation);

  const auditRoot = options.outputRoot ?? 'tmp/catalog-audit';
  await mkdir(auditRoot, { recursive: true });
  const auditPath = path.join(auditRoot, `${options.site.id}.json`);
  await writeFile(auditPath, `${JSON.stringify({ report, discovery, extraction, normalization, validation }, null, 2)}\n`);

  if (options.mode === 'run' && adapter.persist) {
    const persisted = await adapter.persist(options.site, validation.products, auditRoot);
    return { ...report, outputPath: persisted.outputPath };
  }

  return { ...report, outputPath: auditPath };
}

function emptyAudit(options: CatalogPipelineOptions): CatalogAuditReport {
  return {
    siteId: options.site.id,
    siteLabel: options.site.label,
    mode: options.mode,
    categories: 0,
    pages: 0,
    urlsDiscovered: 0,
    urlsUnique: 0,
    productsExtracted: 0,
    productsValid: 0,
    prices: 0,
    sku: 0,
    images: 0,
    duplicates: 0,
    rejected: 0,
    errors: 0,
    estimatedCoverage: 0,
  };
}
