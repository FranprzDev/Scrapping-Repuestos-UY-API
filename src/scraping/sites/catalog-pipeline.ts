import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchHtml } from '../domain/http-client';
import { createCatalogAdapter } from './adapters';
import { auditCounts } from './adapters/base.adapter';
import type { CatalogAuditReport, CatalogAuthentication, CatalogHttpResponse, CatalogPipelineOptions } from './types';
import { parse } from 'node-html-parser';

export async function runCatalogPipeline(options: CatalogPipelineOptions): Promise<CatalogAuditReport> {
  const adapter = createCatalogAdapter(options.site.platform);
  const discoveryOutputRoot = options.outputRoot ?? (options.mode === 'discover' ? 'tmp/catalog-discovery' : 'tmp/catalog-audit');
  const cookieJar = new Map<string, string>();
  await authenticateCatalogSite(options.site.authentication, options.site.label, cookieJar, {
    signal: options.signal,
  });
  const context = {
    site: options.site,
    maxPages: options.maxPages,
    maxProducts: options.maxProducts,
    signal: options.signal,
    fetch: async (url: string, init?: { headers?: Record<string, string> }) => {
      const response = await fetchHtml(url, 5, { headers: init?.headers, signal: options.signal, cookieJar });
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

  if (options.mode === 'run' && options.persistProducts) {
    const persisted = await options.persistProducts(options.site, validation.products);
    return { ...report, outputPath: persisted?.outputPath ?? auditPath };
  }

  if (options.mode === 'run' && adapter.persist) {
    const persisted = await adapter.persist(options.site, validation.products, auditRoot);
    return { ...report, outputPath: persisted.outputPath };
  }

  return { ...report, outputPath: auditPath };
}

type CatalogLoginFetcher = (
  url: string,
  redirects: number,
  init: Parameters<typeof fetchHtml>[2],
) => Promise<CatalogHttpResponse>;

export async function authenticateCatalogSite(
  authentication: CatalogAuthentication,
  siteLabel: string,
  cookieJar: Map<string, string>,
  options: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    fetcher?: CatalogLoginFetcher;
  } = {},
): Promise<void> {
  if (authentication.type !== 'woocommerce-form') return;

  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetchHtml;
  const username = env[authentication.usernameEnv]?.trim();
  const password = env[authentication.passwordEnv];
  if (!username || !password) {
    throw new Error(`Faltan las variables ${authentication.usernameEnv} y/o ${authentication.passwordEnv} para ${siteLabel}`);
  }

  const loginPage = await fetcher(authentication.loginUrl, 5, { signal: options.signal, cookieJar });
  if (loginPage.statusCode >= 400) {
    throw new Error(`No se pudo abrir el login de ${siteLabel}: HTTP ${loginPage.statusCode}`);
  }

  const root = parse(loginPage.body);
  const nonce = root.querySelector('input[name="woocommerce-login-nonce"]')?.getAttribute('value');
  const referer = root.querySelector('input[name="_wp_http_referer"]')?.getAttribute('value') ?? '/mi-cuenta/';
  const body = new URLSearchParams({
    username,
    password,
    login: 'Acceder',
    _wp_http_referer: referer,
    ...(nonce ? { 'woocommerce-login-nonce': nonce } : {}),
  }).toString();
  const loggedIn = await fetcher(authentication.loginUrl, 5, {
    method: 'POST',
    body,
    signal: options.signal,
    cookieJar,
  });
  const loginStillVisible = /name=["'](?:username|password)["']/i.test(loggedIn.body);
  const hasLoginCookie = Array.from(cookieJar.keys()).some((name) => name.startsWith('wordpress_logged_in_'));
  if (loggedIn.statusCode >= 400 || loginStillVisible || !hasLoginCookie) {
    throw new Error(`No se pudo iniciar sesión en ${siteLabel}; verifica las credenciales y el formulario de acceso`);
  }
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
    limited: false,
    terminationReason: 'catalog_end',
    requestedLimits: {
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.maxProducts !== undefined ? { maxProducts: options.maxProducts } : {}),
    },
    pagesAudited: 0,
    productsAudited: 0,
  };
}
