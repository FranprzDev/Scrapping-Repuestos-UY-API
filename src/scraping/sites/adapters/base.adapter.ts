import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';
import type { ProductRecord } from '../../interfaces/scraping.types';
import { extractProductsFromHtml } from '../../domain/domain-html';
import { cleanText, qualityGate } from '../../domain/product-quality';
import type { DomainRule } from '../../domain/domain-rules';
import { normalizeCatalogUrl } from '../catalog-sites';
import { CatalogRequestQueue } from '../catalog-queue';
import type {
  CatalogAdapter,
  CatalogPlatform,
  CatalogRequestContext,
  CatalogSiteConfig,
  DiscoveryPageResult,
  DiscoveryResult,
  ExtractionResult,
  NormalizationResult,
  ValidationResult,
} from '../types';

export abstract class BaseCatalogAdapter implements CatalogAdapter {
  abstract readonly platform: CatalogPlatform;

  async discover(context: CatalogRequestContext): Promise<DiscoveryResult> {
    const pages: DiscoveryPageResult[] = [];
    const errors: DiscoveryResult['errors'] = [];
    const categories = new Set(context.site.seedUrls);
    const discoveredUrls: string[] = [];
    const configuredMaxPages = context.site.paginationStrategy.type === 'none'
      ? Number.POSITIVE_INFINITY
      : context.site.paginationStrategy.maxPages ?? 100;
    const maxPages = Math.min(context.maxPages ?? Number.POSITIVE_INFINITY, configuredMaxPages);

    for (const listingUrl of context.site.seedUrls) {
      const seenInListing = new Set<string>();
      let nextUrl: string | undefined = listingUrl;
      let pageNumber = 1;

      while (nextUrl) {
        if (context.signal?.aborted) {
          throw new Error('Catalog discovery cancelled');
        }
        if (pages.length >= maxPages) {
          break;
        }

        try {
          const response = await context.fetch(nextUrl);
          const page = this.discoverFromHtml(context.site, response.body, response.finalUrl, listingUrl, pageNumber);
          const newInListing = page.productUrls.filter((url) => !seenInListing.has(url));
          page.productUrls.forEach((url) => seenInListing.add(url));
          page.categoryUrls.forEach((url) => categories.add(url));
          discoveredUrls.push(...newInListing);
          pages.push(page);

          if (page.isLastPage || newInListing.length === 0) {
            break;
          }
          nextUrl = page.nextPageUrl;
          pageNumber += 1;
        } catch (error) {
          errors.push({ phase: 'discovery', url: nextUrl, message: formatError(error) });
          break;
        }
      }
    }

    const uniqueUrls = Array.from(new Set(discoveredUrls));
    return {
      siteId: context.site.id,
      categories: Array.from(categories),
      pages,
      discoveredUrls,
      uniqueUrls,
      duplicates: discoveredUrls.length - uniqueUrls.length,
      errors,
    };
  }

  async extract(context: CatalogRequestContext, urls: string[]): Promise<ExtractionResult> {
    const queue = new CatalogRequestQueue({
      globalConcurrency: context.site.concurrency,
      perDomainConcurrency: context.site.concurrency,
      requestDelayMs: context.site.requestDelay,
      signal: context.signal,
    });
    const errors: ExtractionResult['errors'] = [];
    const products: ProductRecord[] = [];

    const tasks = urls.map((url) => ({
      key: url,
      domain: safeDomain(url) ?? context.site.hostname,
      run: async () => {
        try {
          const response = await context.fetch(url);
          return this.extractProductsFromBody(context.site, response.body, response.finalUrl);
        } catch (error) {
          errors.push({ phase: 'extraction', url, message: formatError(error) });
          return [];
        }
      },
    }));

    const extracted = await queue.run(tasks);
    extracted.flat().forEach((product) => products.push(product));
    return { siteId: context.site.id, products, rejected: [], errors };
  }

  normalize(site: CatalogSiteConfig, products: ProductRecord[]): NormalizationResult {
    const duplicates: NormalizationResult['duplicates'] = [];
    const byKey = new Map<string, ProductRecord>();
    for (const product of products) {
      const key = dedupeKey(product);
      if (!key) {
        byKey.set(`anonymous:${byKey.size}`, product);
        continue;
      }
      const previous = byKey.get(key);
      if (previous) {
        duplicates.push({ url: product.sourceUrl, duplicateOf: previous.sourceUrl, reason: key.startsWith('sku:') ? 'sku' : 'canonical_url' });
      }
      byKey.set(key, {
        ...previous,
        ...product,
        extractedAt: product.extractedAt,
      });
    }

    return {
      products: Array.from(byKey.values()).map((product) => ({
        ...product,
        sourceUrl: product.sourceUrl ? normalizeCatalogUrl(product.sourceUrl) ?? product.sourceUrl : undefined,
        currency: product.currency ?? (site.priceLocale === 'es-UY' ? 'UYU' : product.currency),
      })),
      duplicates,
    };
  }

  validate(site: CatalogSiteConfig, products: ProductRecord[]): ValidationResult {
    const valid = qualityGate(products, this.toDomainRule(site));
    const validKeys = new Set(valid.map((product) => product.sourceUrl ?? product.productName).filter(Boolean));
    const rejected = products
      .filter((product) => !validKeys.has(product.sourceUrl ?? product.productName))
      .map((product) => ({ url: product.sourceUrl, reason: product.qualityWarnings?.join(', ') || 'quality_gate' }));
    return { products: valid, rejected };
  }

  async persist(site: CatalogSiteConfig, products: ProductRecord[], outputRoot = 'tmp/catalog-audit'): Promise<{ outputPath: string }> {
    await mkdir(outputRoot, { recursive: true });
    const outputPath = path.join(outputRoot, `${site.id}.json`);
    await writeFile(outputPath, `${JSON.stringify({ site: site.id, products }, null, 2)}\n`);
    return { outputPath };
  }

  protected discoverFromHtml(site: CatalogSiteConfig, html: string, pageUrl: string, listingUrl: string, pageNumber: number): DiscoveryPageResult {
    const root = parse(html);
    const productUrls = new Set<string>();
    const categoryUrls = new Set<string>();

    root.querySelectorAll('a[href]').forEach((anchor) => {
      const url = normalizeCatalogUrl(anchor.getAttribute('href') ?? '', pageUrl);
      if (!url || !sameCatalogHost(url, site.hostname)) {
        return;
      }
      if (site.productUrlPatterns.some((pattern) => pattern.test(url))) {
        productUrls.add(url);
      } else if (site.categoryUrlPatterns.some((pattern) => pattern.test(url))) {
        categoryUrls.add(url);
      }
    });

    const nextPageUrl = this.resolveNextPageUrl(site, html, pageUrl, pageNumber);
    return {
      listingUrl,
      pageUrl,
      pageNumber,
      productUrls: Array.from(productUrls),
      categoryUrls: Array.from(categoryUrls),
      nextPageUrl,
      isLastPage: !nextPageUrl,
    };
  }

  protected extractProductsFromBody(site: CatalogSiteConfig, html: string, pageUrl: string): ProductRecord[] {
    return extractProductsFromHtml(html, pageUrl, 'domain', this.toDomainRule(site));
  }

  protected toDomainRule(site: CatalogSiteConfig): DomainRule {
    return {
      id: site.id,
      hostnames: [site.hostname, `www.${site.hostname}`],
      seedUrls: site.seedUrls,
      preferredMethod: 'http',
      preserveOutOfStock: site.preserveOutOfStock,
      productUrlPatterns: site.productUrlPatterns,
      categoryUrlPatterns: site.categoryUrlPatterns,
      excludeUrlPatterns: [/\/(?:cart|carrito|checkout|mi-cuenta|account|login|contacto|blog)(?:\/|\?|$)/i],
      positiveAvailabilityTexts: ['comprar', 'agregar al carrito', 'anadir al carrito', 'en stock', 'disponible'],
      negativeAvailabilityTexts: ['agotado', 'sin stock', 'out of stock', 'no disponible'],
    };
  }

  private resolveNextPageUrl(site: CatalogSiteConfig, html: string, pageUrl: string, pageNumber: number): string | undefined {
    const root = parse(html);
    const strategy = site.paginationStrategy;
    if (strategy.type === 'none') {
      return undefined;
    }
    if (strategy.type === 'next-link') {
      const selector = strategy.selector ?? 'a[rel="next"], link[rel="next"], .next a[href], a.next[href]';
      const href = root.querySelector(selector)?.getAttribute('href');
      return href ? normalizeCatalogUrl(href, pageUrl) : undefined;
    }
    if (strategy.type === 'page-param') {
      const nextPage = pageNumber + 1;
      if (strategy.maxPages && nextPage > strategy.maxPages) {
        return undefined;
      }
      const url = new URL(pageUrl);
      url.searchParams.set(strategy.param, String(nextPage));
      return url.toString();
    }
    return undefined;
  }
}

export function auditCounts(site: CatalogSiteConfig, mode: 'discover' | 'probe' | 'audit' | 'run', discovery: DiscoveryResult, extraction: ExtractionResult, normalization: NormalizationResult, validation: ValidationResult) {
  const productsWithImages = validation.products.filter((product) => product.imageUrl || product.imageUrls?.length).length;
  return {
    siteId: site.id,
    siteLabel: site.label,
    mode,
    categories: discovery.categories.length,
    pages: discovery.pages.length,
    urlsDiscovered: discovery.discoveredUrls.length,
    urlsUnique: discovery.uniqueUrls.length,
    productsExtracted: extraction.products.length,
    productsValid: validation.products.length,
    prices: validation.products.filter((product) => cleanText(product.price)).length,
    sku: validation.products.filter((product) => cleanText(product.sku)).length,
    images: productsWithImages,
    duplicates: discovery.duplicates + normalization.duplicates.length,
    rejected: extraction.rejected.length + validation.rejected.length,
    errors: discovery.errors.length + extraction.errors.length,
    estimatedCoverage: discovery.uniqueUrls.length > 0 ? validation.products.length / discovery.uniqueUrls.length : 0,
  };
}

function dedupeKey(product: ProductRecord): string | undefined {
  const sourceUrl = product.sourceUrl ? normalizeCatalogUrl(product.sourceUrl) : undefined;
  if (sourceUrl) {
    return `url:${sourceUrl.toLowerCase()}`;
  }
  if (product.sku) {
    return `sku:${product.sku.toLowerCase()}`;
  }
  return product.productName ? `name:${product.productName.toLowerCase()}` : undefined;
}

function safeDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function sameCatalogHost(url: string, hostname: string): boolean {
  const candidate = safeDomain(url);
  const expected = hostname.replace(/^www\./, '').toLowerCase();
  return candidate === expected || candidate === `api.${expected}` || candidate?.endsWith(`.${expected}`) === true;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
