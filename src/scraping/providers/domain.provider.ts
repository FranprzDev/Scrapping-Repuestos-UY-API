import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { parse } from 'node-html-parser';
import { ProductRecord, ProviderResult, ScrapingOperationPayload, ScrapingProvider, ScrapingTask } from '../interfaces/scraping.types';
import {
  buildGrFrenosBrandUrl,
  extractChapareiBrandsFromHtml,
  extractCompatibilityFromHtml,
  extractCandidateLinks,
  extractGrFrenosBrandsFromHtml,
  extractGrFrenosListingSummary,
  extractProductsFromHtml,
  isGrFrenosChallengeHtml,
} from '../domain/domain-html';
import { DomainRule, findDomainRule, getSeedUrls } from '../domain/domain-rules';
import { type HttpRequestInit, type HttpResponseData, fetchHtml } from '../domain/http-client';
import {
  buildFenicioPageUrl,
  buildLarriqueBrandUrl,
  buildLarriqueFinalPageUrl,
  buildShopifyProductsUrl,
  CatalogBrandSeed,
  extractCymacoBrandSeeds,
  extractFamilcarBrandSeeds,
  extractFenicioPageSummary,
  extractFenicioProducts,
  extractLarriqueContextBrand,
  extractLarriqueProducts,
  extractLarriqueTotalResults,
  extractShopifyProducts,
  parseLarriqueBrandResponse,
} from '../domain/new-catalog-sites';
import { cleanText, dedupeProducts, inferCurrency, mergeCompatibleBrands, normalizePriceValue, qualityGate } from '../domain/product-quality';
import { PlaywrightProvider } from './playwright.provider';

@Injectable()
export class DomainProvider implements ScrapingProvider {
  readonly name = 'domain' as const;
  private readonly logger = new Logger(DomainProvider.name);
  private readonly extractConcurrency = clampNumber(Number(process.env.DOMAIN_EXTRACT_CONCURRENCY), 1, 10, 4);

  constructor(@Inject(PlaywrightProvider) private readonly playwrightProvider: PlaywrightProvider) {}

  async run(task: ScrapingTask, payload: ScrapingOperationPayload): Promise<ProviderResult> {
    const sourceUrl = typeof payload.url === 'string' ? payload.url : undefined;

    if (!sourceUrl) {
      return {
        provider: this.name,
        task,
        requestedAt: new Date().toISOString(),
        raw: { warning: 'DomainProvider requiere url' },
        normalizedProducts: [],
      };
    }

    if (task === 'crawl') {
      const raw = await this.crawl(sourceUrl, payload);
      return {
        provider: this.name,
        task,
        requestedAt: new Date().toISOString(),
        sourceUrl,
        raw,
        normalizedProducts: [],
      };
    }

    const raw = await this.extract(sourceUrl, payload);
    return {
      provider: this.name,
      task,
      requestedAt: new Date().toISOString(),
      sourceUrl,
      raw,
      normalizedProducts: raw.products,
    };
  }

  private async crawl(sourceUrl: string, payload: ScrapingOperationPayload) {
    const rule = findDomainRule(sourceUrl);
    const limit = clampNumber(payload.limit, 1, 1000000, 30);

    if (!rule) {
      const fallback = await this.playwrightProvider.run('crawl', { ...payload, url: sourceUrl, limit });
      const raw = fallback.raw as {
        seedUrl?: string;
        pages?: Array<{ url: string; depth?: number; title?: string; links?: string[]; products?: ProductRecord[] }>;
        discoveredUrls?: string[];
      };

      return {
        seedUrl: raw.seedUrl ?? sourceUrl,
        pages: raw.pages ?? [],
        discoveredUrls: raw.discoveredUrls ?? [],
        discoveryMethod: 'playwright-fallback',
      };
    }

    if (rule.id === 'chaparei') {
      return await this.crawlChaparei(sourceUrl, limit, rule);
    }

    if (rule.id === 'grfrenos') {
      return await this.crawlGrFrenos(sourceUrl);
    }

    if (rule.id === 'selvir') {
      const response = await fetchHtml(sourceUrl);
      return {
        seedUrl: sourceUrl,
        pages: [{ url: response.finalUrl, depth: 0, productCount: extractProductsFromHtml(response.body, response.finalUrl, this.name, rule).length }],
        discoveredUrls: [sourceUrl],
        discoveryMethod: 'selvir-http',
      };
    }

    if (rule.id === 'taxitor') {
      return await this.crawlTaxitor(sourceUrl, limit, rule);
    }

    if (rule.id === 'europarts') {
      const response = await fetchHtml(buildEuropartsCatalogUrl(sourceUrl, 100));
      const total = extractEuropartsTotal(response.body);
      const catalogUrl = buildEuropartsCatalogUrl(response.finalUrl, total ?? 100);
      return {
        seedUrl: sourceUrl,
        pages: [{ url: response.finalUrl, depth: 0, productCount: total ?? 0 }],
        discoveredUrls: [catalogUrl],
        discoveryMethod: 'europarts-http',
      };
    }

    if (rule.id === 'multishop') {
      return {
        seedUrl: sourceUrl,
        pages: [{ url: buildShopifyProductsUrl(sourceUrl, 1), depth: 0, productCount: 0 }],
        discoveredUrls: [sourceUrl],
        discoveryMethod: 'shopify-json',
      };
    }

    if (rule.id === 'cymaco' || rule.id === 'familcar') {
      return await this.crawlFenicio(sourceUrl, rule.id);
    }

    if (rule.id === 'larrique') {
      return await this.crawlLarrique(sourceUrl);
    }

    if (rule.preferredMethod === 'api') {
      return {
        seedUrl: sourceUrl,
        pages: [{ url: sourceUrl, title: rule.id, depth: 0, productCount: 0 }],
        discoveredUrls: [sourceUrl],
        discoveryMethod: 'domain-api',
      };
    }

    const queue = getSeedUrls(sourceUrl, rule).map((url) => ({ url, depth: 0 }));
    const visited = new Set<string>();
    const discoveredProducts = new Set<string>();
    const pages: Array<{ url: string; depth: number; productCount: number }> = [];

    while (queue.length > 0 && pages.length < limit) {
      const current = queue.shift();
      if (!current || visited.has(current.url)) {
        continue;
      }

      visited.add(current.url);

      try {
        const response = await fetchHtml(current.url);
        const { productLinks, categoryLinks } = extractCandidateLinks(response.body, response.finalUrl, rule);
        productLinks.forEach((url) => discoveredProducts.add(url));
        pages.push({
          url: response.finalUrl,
          depth: current.depth,
          productCount: productLinks.length,
        });

        if (current.depth >= 2) {
          continue;
        }

        for (const categoryUrl of categoryLinks) {
          if (visited.has(categoryUrl) || queue.length + pages.length >= limit) {
            continue;
          }

          queue.push({ url: categoryUrl, depth: current.depth + 1 });
        }
      } catch (error) {
        this.logger.warn(`No se pudo descubrir ${current.url}: ${formatError(error)}`);
      }
    }

    return {
      seedUrl: sourceUrl,
      pages,
      discoveredUrls: Array.from(discoveredProducts),
      discoveryMethod: 'domain-http',
    };
  }

  private async extract(sourceUrl: string, payload: ScrapingOperationPayload) {
    const rule = findDomainRule(sourceUrl);
    const maxItems = clampNumber(payload.maxItems, 1, 1000000, 150);
    const urls = uniqueStrings([
      ...(Array.isArray(payload.urls) ? payload.urls.filter((value): value is string => typeof value === 'string') : []),
      sourceUrl,
    ]);

    if (!rule) {
      const fallback = await this.playwrightProvider.run('extract', { ...payload, urls, url: sourceUrl });
      return {
        urls,
        pages: [],
        products: qualityGate(fallback.normalizedProducts),
        fallback: 'playwright',
      };
    }

    if (rule.preferredMethod === 'api') {
      const products = await this.extractAcesurProducts(sourceUrl, maxItems);
      return {
        urls: [sourceUrl],
        pages: [{ url: sourceUrl, method: 'api', productCount: products.length }],
        products: qualityGate(products, rule).slice(0, maxItems),
      };
    }

    if (rule.id === 'chaparei') {
      const chaparei = await this.extractChapareiProducts(urls, maxItems, rule);
      return {
        urls: chaparei.urls,
        pages: chaparei.pages,
        products: await this.enrichProductDetails(dedupeProducts(qualityGate(chaparei.products, rule)), rule, maxItems),
      };
    }

    if (rule.id === 'grfrenos') {
      const grfrenos = await this.extractGrFrenosProducts(urls, maxItems, rule);
      return {
        urls: grfrenos.urls,
        pages: grfrenos.pages,
        products: await this.enrichProductDetails(dedupeProducts(qualityGate(grfrenos.products, rule)), rule, maxItems),
      };
    }

    if (rule.id === 'europarts') {
      const initialResponse = await fetchHtml(buildEuropartsCatalogUrl(sourceUrl, 100));
      const total = extractEuropartsTotal(initialResponse.body) ?? 100;
      const catalogUrl = buildEuropartsCatalogUrl(initialResponse.finalUrl, total);
      const response = total <= 100 ? initialResponse : await fetchHtml(catalogUrl);
      const products = qualityGate(extractProductsFromHtml(response.body, response.finalUrl, this.name, rule), rule);
      return {
        urls: [catalogUrl],
        pages: [{ url: response.finalUrl, method: 'europarts-http', productCount: products.length }],
        products: await this.enrichProductDetails(dedupeProducts(products), rule, maxItems),
      };
    }

    if (rule.id === 'multishop') {
      const result = await this.extractMultishopProducts(sourceUrl, maxItems);
      return {
        ...result,
        products: await this.enrichProductDetails(result.products, rule, maxItems),
      };
    }

    if (rule.id === 'cymaco' || rule.id === 'familcar') {
      const result = await this.extractFenicioCatalog(urls, sourceUrl, maxItems, rule.id);
      return {
        ...result,
        products: await this.enrichProductDetails(result.products, rule, maxItems),
      };
    }

    if (rule.id === 'larrique') {
      const result = await this.extractLarriqueCatalog(urls, sourceUrl, maxItems);
      return {
        ...result,
        products: await this.enrichProductDetails(result.products, rule, maxItems),
      };
    }

    const processed = await mapWithConcurrency(urls, this.extractConcurrency, async (url) => {
      let usableProducts: ProductRecord[] = [];
      let method = 'http';

      try {
        if (rule.id === 'selvir') {
          const response = await fetchHtml(url);
          const archiveSummary = extractSelvirArchiveSummary(response.body, response.finalUrl);

          if (archiveSummary) {
            usableProducts = await this.extractSelvirArchiveProducts(url, response, archiveSummary, maxItems, rule);
            method = 'selvir-ajax';
          } else {
            usableProducts = qualityGate(extractProductsFromHtml(response.body, response.finalUrl, this.name, rule), rule);
          }
        } else {
          const response = await fetchHtml(url);
          usableProducts = qualityGate(extractProductsFromHtml(response.body, response.finalUrl, this.name, rule), rule);
        }
      } catch (error) {
        this.logger.warn(`HTTP scrape fallido para ${url}: ${formatError(error)}`);
      }

      if (usableProducts.length === 0 && rule.preferredMethod === 'playwright-fallback') {
        const fallback = await this.playwrightProvider.run('extract', { urls: [url], url, maxItems });
        usableProducts = qualityGate(fallback.normalizedProducts, rule);
        method = 'playwright-fallback';
      }

      return {
        page: {
          url,
          method,
          productCount: usableProducts.length,
        },
        products: usableProducts,
      };
    });

    const pages = processed.map((item) => item.page);
    const collected = processed.flatMap((item) => item.products).slice(0, maxItems);

    return {
      urls,
      pages,
      products: await this.enrichProductDetails(dedupeProducts(collected), rule, maxItems),
    };
  }

  private async crawlFenicio(sourceUrl: string, site: 'cymaco' | 'familcar') {
    const response = await fetchHtml(sourceUrl);
    const brands = site === 'cymaco'
      ? extractCymacoBrandSeeds(response.body, response.finalUrl)
      : extractFamilcarBrandSeeds(response.body, response.finalUrl);

    return {
      seedUrl: sourceUrl,
      pages: [{ url: response.finalUrl, depth: 0, productCount: brands.length }],
      discoveredUrls: brands.map((brand) => brand.sourceUrl),
      discoveryMethod: 'fenicio-http',
    };
  }

  private async crawlLarrique(sourceUrl: string) {
    const session = createCookieSession();
    const response = await session.fetch(sourceUrl);
    const csrf = cleanText(parse(response.body).querySelector('input[name="YII_CSRF_TOKEN"]')?.getAttribute('value'));
    if (!csrf) {
      throw new Error('Larrique no expuso el token CSRF para descubrir marcas');
    }

    const body = new URLSearchParams({
      aux1: '',
      secondaryAuxs: '{}',
      noQuery: '1',
      _csrf: csrf,
    }).toString();
    const brandsResponse = await session.fetch(new URL('/special-search/search-for-selectize', response.finalUrl).toString(), {
      method: 'POST',
      body,
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        referer: response.finalUrl,
      },
    });
    const brands = parseLarriqueBrandResponse(brandsResponse.body);

    return {
      seedUrl: sourceUrl,
      pages: [{ url: response.finalUrl, depth: 0, productCount: brands.length }],
      discoveredUrls: brands.map((brand) => buildLarriqueBrandUrl(response.finalUrl, brand)),
      discoveryMethod: 'larrique-http',
    };
  }

  private async extractMultishopProducts(sourceUrl: string, maxItems: number) {
    const products: ProductRecord[] = [];
    const pages: Array<{ url: string; method: string; productCount: number }> = [];
    const pageSize = 250;

    for (let page = 1; products.length < maxItems; page += 1) {
      const url = buildShopifyProductsUrl(sourceUrl, page, pageSize);
      const response = await fetchHtml(url);
      const extracted = extractShopifyProducts(response.body, sourceUrl, this.name);
      pages.push({ url: response.finalUrl, method: 'shopify-json', productCount: extracted.products.length });
      products.push(...extracted.products);
      if (extracted.received < pageSize) {
        break;
      }
    }

    return {
      urls: pages.map((page) => page.url),
      pages,
      products: dedupeProducts(qualityGate(products, findDomainRule(sourceUrl))).slice(0, maxItems),
    };
  }

  private async extractFenicioCatalog(
    urls: string[],
    sourceUrl: string,
    maxItems: number,
    site: 'cymaco' | 'familcar',
  ) {
    const home = await fetchHtml(sourceUrl);
    const discovered = site === 'cymaco'
      ? extractCymacoBrandSeeds(home.body, home.finalUrl)
      : extractFamilcarBrandSeeds(home.body, home.finalUrl);
    const knownByUrl = new Map(discovered.map((brand) => [brand.sourceUrl, brand]));
    const requested = urls
      .map((url) => knownByUrl.get(url) ?? inferFenicioBrandSeed(url, site))
      .filter((brand): brand is CatalogBrandSeed => Boolean(brand));
    const brandSeeds = requested.length > 0 ? uniqueBrandEntries(requested) : discovered;
    const rule = findDomainRule(sourceUrl);

    const firstResults = await mapWithConcurrency(brandSeeds, this.extractConcurrency, async (brand) => {
      const first = await fetchHtmlWithRetry(brand.sourceUrl);
      const summary = extractFenicioPageSummary(first.body);
      const pageSize = summary?.pageItems || 12;
      const totalPages = summary?.totalResults ? Math.ceil(summary.totalResults / pageSize) : 1;
      const products = extractFenicioProducts(first.body, first.finalUrl, this.name, brand.brandLabel);
      return {
        brand,
        totalPages: Math.min(totalPages, Math.ceil(maxItems / pageSize)),
        page: { url: first.finalUrl, method: 'fenicio-http', productCount: products.length },
        products,
      };
    });
    const pageTasks = firstResults.flatMap((result) =>
      Array.from({ length: Math.max(0, result.totalPages - 1) }, (_, index) => ({
        brand: result.brand,
        page: index + 2,
      })),
    );
    const remainingResults = await mapWithConcurrency(pageTasks, this.extractConcurrency, async ({ brand, page }) => {
      const pageUrl = buildFenicioPageUrl(brand.sourceUrl, page);
      const response = await fetchHtmlWithRetry(pageUrl, {
        headers: {
          'x-requested-with': 'XMLHttpRequest',
          referer: brand.sourceUrl,
        },
      });
      const batch = extractFenicioProducts(response.body, response.finalUrl, this.name, brand.brandLabel);
      return {
        page: { url: response.finalUrl, method: 'fenicio-http', productCount: batch.length },
        products: batch,
      };
    });

    const allResults = [...firstResults, ...remainingResults];
    const products = dedupeProducts(qualityGate(allResults.flatMap((result) => result.products), rule)).slice(0, maxItems);
    return {
      urls: brandSeeds.map((brand) => brand.sourceUrl),
      pages: allResults.map((result) => result.page),
      products,
    };
  }

  private async extractLarriqueCatalog(urls: string[], sourceUrl: string, maxItems: number) {
    const requested = urls.filter((url) => /\/search-by\/\d+/i.test(url));
    const brandUrls = requested.length > 0
      ? uniqueStrings(requested)
      : (await this.crawlLarrique(sourceUrl)).discoveredUrls;
    const rule = findDomainRule(sourceUrl);

    const results = await mapWithConcurrency(brandUrls, this.extractConcurrency, async (brandUrl) => {
      const first = await fetchHtml(brandUrl);
      const totalResults = extractLarriqueTotalResults(first.body) ?? 0;
      const finalUrl = totalResults > 24 ? buildLarriqueFinalPageUrl(first.finalUrl, totalResults) : first.finalUrl;
      const finalResponse = finalUrl === first.finalUrl ? first : await fetchHtml(finalUrl);
      const brand = extractLarriqueContextBrand(brandUrl);
      const products = qualityGate(extractLarriqueProducts(finalResponse.body, finalResponse.finalUrl, this.name, brand), rule);

      return {
        page: { url: finalResponse.finalUrl, method: 'larrique-http', productCount: products.length },
        products,
      };
    });

    return {
      urls: brandUrls,
      pages: results.map((result) => result.page),
      products: dedupeProducts(results.flatMap((result) => result.products)).slice(0, maxItems),
    };
  }

  private async enrichProductDetails(products: ProductRecord[], rule: DomainRule, maxItems: number): Promise<ProductRecord[]> {
    const candidates = products.filter((product) => Boolean(product.sourceUrl)).slice(0, maxItems);
    const enriched = await mapWithConcurrency(candidates, this.extractConcurrency, async (product) => {
      try {
        const response = await fetchHtml(product.sourceUrl as string);
        const compatibility = extractCompatibilityFromHtml(response.body);
        const detail = extractProductsFromHtml(response.body, response.finalUrl, this.name, rule)
          .find((item) => item.sourceUrl === response.finalUrl || item.sourceUrl === product.sourceUrl);

        return {
          ...product,
          ...(detail ?? {}),
          sourceUrl: product.sourceUrl,
          compatibleVehicles: mergeTextValues(product.compatibleVehicles, compatibility.compatibleVehicles),
          compatibleModels: mergeTextValues(product.compatibleModels, compatibility.compatibleModels),
          compatibleVersions: mergeTextValues(product.compatibleVersions, compatibility.compatibleVersions),
        };
      } catch (error) {
        this.logger.warn(`No se pudo enriquecer detalle ${product.sourceUrl}: ${formatError(error)}`);
        return product;
      }
    });

    return enriched;
  }

  private async crawlChaparei(sourceUrl: string, limit: number, rule: DomainRule) {
    const session = createChapareiSession();

    try {
      const response = await session.fetch(sourceUrl);
      const brandSeeds = this.resolveChapareiBrandSeeds(response, sourceUrl).slice(0, limit);

      return {
        seedUrl: sourceUrl,
        pages: [{ url: response.finalUrl, depth: 0, productCount: brandSeeds.length }],
        discoveredUrls: brandSeeds,
        discoveryMethod: 'chaparei-http',
      };
    } catch (error) {
      this.logger.warn(`No se pudo descubrir Chaparei ${sourceUrl}: ${formatError(error)}`);
      return {
        seedUrl: sourceUrl,
        pages: [],
        discoveredUrls: [sourceUrl],
        discoveryMethod: 'chaparei-http',
      };
    }
  }

  private async extractChapareiProducts(urls: string[], maxItems: number, rule: DomainRule) {
    const discoveryUrls = uniqueStrings(urls);
    const brandSeeds = new Map<string, string | undefined>();

    for (const discoveryUrl of discoveryUrls) {
      try {
        const session = createChapareiSession();
        const response = await session.fetch(discoveryUrl);
        this.resolveChapareiBrandSeedEntries(response, discoveryUrl).forEach(({ sourceUrl, brandLabel }) => {
          if (!brandSeeds.has(sourceUrl)) {
            brandSeeds.set(sourceUrl, brandLabel);
            return;
          }

          if (!brandSeeds.get(sourceUrl) && brandLabel) {
            brandSeeds.set(sourceUrl, brandLabel);
          }
        });
      } catch (error) {
        this.logger.warn(`No se pudo resolver Chaparei ${discoveryUrl}: ${formatError(error)}`);
      }
    }

    const brandSeedEntries = Array.from(brandSeeds.entries()).map(([sourceUrl, brandLabel]) => ({ sourceUrl, brandLabel }));
    if (brandSeedEntries.length === 0) {
      return {
        urls: discoveryUrls,
        pages: [],
        products: [] as ProductRecord[],
      };
    }

    const results = await mapWithConcurrency(brandSeedEntries, this.extractConcurrency, async (brandSeed) =>
      this.extractChapareiBrandSeries(brandSeed, maxItems, rule),
    );

    return {
      urls: brandSeedEntries.map((entry) => entry.sourceUrl),
      pages: results.flatMap((item) => item.pages),
      products: dedupeProducts(results.flatMap((item) => item.products)).slice(0, maxItems),
    };
  }

  private async extractChapareiBrandSeries(
    brandSeed: { sourceUrl: string; brandLabel?: string },
    maxItems: number,
    rule: DomainRule,
  ) {
    const { sourceUrl: brandUrl, brandLabel } = brandSeed;
    const session = createChapareiSession();
    const pages: Array<{ url: string; method: string; productCount: number }> = [];
    const collected: ProductRecord[] = [];

    try {
      const firstResponse = await session.fetch(brandUrl);
      const firstBatch = applyChapareiContextBrand(
        qualityGate(extractProductsFromHtml(firstResponse.body, firstResponse.finalUrl, this.name, rule), rule),
        brandLabel,
      );

      if (firstBatch.length > 0) {
        collected.push(...firstBatch);
        pages.push({
          url: firstResponse.finalUrl,
          method: 'http',
          productCount: firstBatch.length,
        });
      }

      for (let page = 1; collected.length < maxItems; page += 1) {
        const ajaxUrl = buildChapareiAjaxPageUrl(firstResponse.finalUrl, page);
        const ajaxResponse = await session.fetch(ajaxUrl);

        if (!ajaxResponse.body.trim()) {
          break;
        }

        const batch = applyChapareiContextBrand(
          qualityGate(extractProductsFromHtml(ajaxResponse.body, ajaxResponse.finalUrl, this.name, rule), rule),
          brandLabel,
        );
        if (batch.length === 0) {
          break;
        }

        const merged = dedupeProducts([...collected, ...batch]).slice(0, maxItems);
        if (merged.length <= collected.length) {
          break;
        }

        collected.length = 0;
        collected.push(...merged);
        pages.push({
          url: ajaxResponse.finalUrl,
          method: 'http',
          productCount: batch.length,
        });
      }
    } catch (error) {
      this.logger.warn(`No se pudo extraer Chaparei ${brandUrl}: ${formatError(error)}`);
    }

    return {
      pages,
      products: collected,
    };
  }

  private async crawlGrFrenos(sourceUrl: string) {
    try {
      const homeResponse = await fetchHtml(sourceUrl);
      const brandSeeds = extractGrFrenosBrandsFromHtml(homeResponse.body, homeResponse.finalUrl);
      const discoveredUrls = brandSeeds.map((brand) => brand.sourceUrl);

      return {
        seedUrl: sourceUrl,
        pages: [
          {
            url: homeResponse.finalUrl,
            depth: 0,
            productCount: brandSeeds.length,
          },
          ...brandSeeds.map((brand) => ({
            url: brand.sourceUrl,
            depth: 1,
            productCount: 0,
          })),
        ],
        discoveredUrls: discoveredUrls.length > 0 ? uniqueStrings(discoveredUrls) : [sourceUrl],
        discoveryMethod: 'grfrenos-http',
      };
    } catch (error) {
      this.logger.warn(`No se pudo descubrir GR Frenos ${sourceUrl}: ${formatError(error)}`);
      return {
        seedUrl: sourceUrl,
        pages: [],
        discoveredUrls: [sourceUrl],
        discoveryMethod: 'grfrenos-http',
      };
    }
  }

  private async extractGrFrenosProducts(urls: string[], maxItems: number, rule: DomainRule) {
    const discoveryUrls = uniqueStrings(urls);
    const pages: Array<{ url: string; method: string; productCount: number }> = [];
    const collected: ProductRecord[] = [];

    for (const discoveryUrl of discoveryUrls) {
      try {
        const response = await fetchHtml(discoveryUrl);
        const summary = extractGrFrenosListingSummary(response.body);
        const brandId = extractGrFrenosBrandId(response.finalUrl) ?? extractGrFrenosBrandId(discoveryUrl);
        const brandLabel = summary?.brandLabel ?? 'unknown';
        const totalResults = summary?.totalResults;
        const challengeDetected = isGrFrenosChallengeHtml(response.body);

        if (!brandId) {
          this.logger.warn(`GR Frenos brand discovery sin brandId url=${discoveryUrl}`);
          continue;
        }

        if (challengeDetected) {
          this.logger.warn(`GR Frenos challenge detectado brandId=${brandId} brandLabel=${brandLabel} url=${response.finalUrl}`);
        }

        if (typeof totalResults !== 'number') {
          this.logger.warn(
            `GR Frenos sin totalResults brandId=${brandId} brandLabel=${brandLabel} url=${response.finalUrl} challenge=${challengeDetected ? 'yes' : 'no'}`,
          );
        }

        const finalUrl = typeof totalResults === 'number'
          ? buildGrFrenosBrandUrl(response.finalUrl, brandId, totalResults)
          : response.finalUrl;
        const finalResponse = finalUrl === response.finalUrl ? response : await fetchHtml(finalUrl);
        const batch = qualityGate(
          applyGrFrenosContextBrand(
            extractProductsFromHtml(finalResponse.body, finalResponse.finalUrl, this.name, rule),
            summary?.brandLabel,
          ),
          rule,
        );

        this.logger.log(
          `GR Frenos brand complete brandId=${brandId} brandLabel=${brandLabel} totalResults=${typeof totalResults === 'number' ? totalResults : 'unknown'} finalUrl=${finalResponse.finalUrl} cards=${batch.length}`,
        );

        pages.push({
          url: finalResponse.finalUrl,
          method: 'http',
          productCount: batch.length,
        });
        collected.push(...batch);
      } catch (error) {
        this.logger.warn(`No se pudo extraer GR Frenos ${discoveryUrl}: ${formatError(error)}`);
      }
    }

    return {
      urls: discoveryUrls,
      pages,
      products: dedupeProducts(collected).slice(0, maxItems),
    };
  }

  private resolveChapareiBrandSeeds(response: HttpResponseData, sourceUrl: string): string[] {
    return this.resolveChapareiBrandSeedEntries(response, sourceUrl).map((entry) => entry.sourceUrl);
  }

  private resolveChapareiBrandSeedEntries(
    response: HttpResponseData,
    sourceUrl: string,
  ): Array<{ sourceUrl: string; brandLabel?: string }> {
    const parsedBrands = extractChapareiBrandsFromHtml(response.body, response.finalUrl);
    if (parsedBrands.length > 0 && isChapareiBrandHubUrl(response.finalUrl)) {
      return parsedBrands.map(({ sourceUrl: parsedSourceUrl, brandLabel }) => ({
        sourceUrl: parsedSourceUrl,
        brandLabel,
      }));
    }

    const contextualBrandLabel =
      extractChapareiBrandLabelFromUrl(response.finalUrl, parsedBrands)
      ?? extractChapareiBrandLabelFromUrl(sourceUrl, parsedBrands);
    const canonicalBrandUrl = extractChapareiCanonicalBrandUrl(response.body, response.finalUrl);
    if (canonicalBrandUrl || contextualBrandLabel) {
      return [{
        sourceUrl: canonicalBrandUrl ?? sourceUrl,
        brandLabel: contextualBrandLabel,
      }];
    }

    if (parsedBrands.length > 0) {
      return parsedBrands.map(({ sourceUrl: parsedSourceUrl, brandLabel }) => ({
        sourceUrl: parsedSourceUrl,
        brandLabel,
      }));
    }

    return [{ sourceUrl }];
  }

  private async extractAcesurProducts(seedUrl: string, maxItems: number): Promise<ProductRecord[]> {
    const uuid = randomUUID();
    const customerCode = process.env.ACESUR_CUSTOMER_CODE?.trim();
    this.logger.log(`Acesur extract start seed=${seedUrl} customerCode=${customerCode ? 'yes' : 'no'}`);
    const rubros = await fetchAcesurRubros(uuid, customerCode);
    this.logger.log(`Acesur rubros found count=${rubros.length}`);
    return extractAcesurProductsByRubro(rubros, {
      uuid,
      seedUrl,
      provider: this.name,
      maxItems,
      logger: this.logger,
      customerCode,
      crawlCategory: crawlAcesurCategory,
    });
  }

  private async extractSelvirArchiveProducts(
    categoryUrl: string,
    initialResponse: Awaited<ReturnType<typeof fetchHtml>>,
    archiveSummary: { categoryLabel: string; totalResults?: number; totalPages?: number },
    maxItems: number,
    rule: DomainRule,
  ): Promise<ProductRecord[]> {
    const products = qualityGate(
      extractProductsFromHtml(initialResponse.body, initialResponse.finalUrl, this.name, rule),
      rule,
    );
    const totalPages = archiveSummary.totalPages ?? 1;
    const pageUrlBase = initialResponse.finalUrl;

    for (let page = 2; page <= totalPages && products.length < maxItems; page += 1) {
      const ajaxResponse = await fetchSelvirArchivePage(categoryUrl, archiveSummary.categoryLabel, page);
      const ajaxPayload = parseSelvirAjaxResponse(ajaxResponse.body);
      let batch = qualityGate(
        extractProductsFromHtml(ajaxPayload.html, pageUrlBase, this.name, rule),
        rule,
      );

      if (batch.length === 0) {
        try {
          const fallbackResponse = await fetchHtml(buildSelvirArchivePageUrl(pageUrlBase, page));
          batch = qualityGate(
            extractProductsFromHtml(fallbackResponse.body, fallbackResponse.finalUrl, this.name, rule),
            rule,
          );
        } catch (error) {
          this.logger.warn(`No se pudo leer pagina Selvir ${pageUrlBase} page=${page}: ${formatError(error)}`);
        }
      }

      if (batch.length === 0) {
        break;
      }

      const merged = dedupeProducts([...products, ...batch]).slice(0, maxItems);
      if (merged.length <= products.length) {
        break;
      }

      products.length = 0;
      products.push(...merged);

      if (ajaxPayload.last) {
        break;
      }
    }

    return dedupeProducts(products).slice(0, maxItems);
  }

  private async crawlTaxitor(sourceUrl: string, limit: number, rule: DomainRule) {
    const pages: Array<{ url: string; depth: number; productCount: number }> = [];
    const discoveredUrls: string[] = [];
    const seenPageUrls = new Set<string>();
    const collectedProducts: ProductRecord[] = [];
    let nextUrl: string | undefined = sourceUrl;

    while (nextUrl && pages.length < limit) {
      if (seenPageUrls.has(nextUrl)) {
        break;
      }

      seenPageUrls.add(nextUrl);

      try {
        this.logger.log(`Taxitor fetch page=${nextUrl}`);
        const response = await fetchHtml(nextUrl);
        const pageProducts = qualityGate(
          extractProductsFromHtml(response.body, response.finalUrl, this.name, rule),
          rule,
        );
        const pagination = extractTaxitorPaginationSummary(response.body, response.finalUrl);

        if (pageProducts.length === 0) {
          break;
        }

        const mergedProducts = dedupeProducts([...collectedProducts, ...pageProducts]);
        if (mergedProducts.length <= collectedProducts.length) {
          break;
        }

        collectedProducts.length = 0;
        collectedProducts.push(...mergedProducts);
        pages.push({
          url: response.finalUrl,
          depth: pages.length,
          productCount: pageProducts.length,
        });
        this.logger.log(`Taxitor page_ok page=${response.finalUrl} products=${pageProducts.length}`);
        discoveredUrls.push(response.finalUrl);

        if (!pagination.nextPageUrl || seenPageUrls.has(pagination.nextPageUrl)) {
          break;
        }

        nextUrl = pagination.nextPageUrl;
      } catch (error) {
        this.logger.warn(`No se pudo leer pagina Taxitor ${nextUrl}: ${formatError(error)}`);
        break;
      }
    }

    if (discoveredUrls.length === 0) {
      discoveredUrls.push(sourceUrl);
    }

    return {
      seedUrl: sourceUrl,
      pages,
      discoveredUrls,
      discoveryMethod: 'taxitor-http',
    };
  }
}

export function extractEuropartsTotal(body: string): number | undefined {
  const root = parse(body);
  const summary = root.querySelectorAll('.product-show-option p')
    .map((element) => cleanText(element.text))
    .find((text) => text?.toLowerCase().startsWith('mostrando '));
  const lastPart = summary?.split(/\s+/).at(-1);
  const total = Number(lastPart);
  return Number.isInteger(total) && total > 0 ? total : undefined;
}

export function buildEuropartsCatalogUrl(sourceUrl: string, recordSize: number): string {
  const url = new URL(sourceUrl);
  url.searchParams.set('recordsize', String(clampNumber(recordSize, 1, 1000000, 100)));
  return url.toString();
}

export function buildSelvirArchivePageUrl(baseUrl: string, page: number): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(`page/${page}/`, normalizedBase).toString();
}

export function parseAcesurApi(body: string, sourceUrl: string, provider: 'domain'): { totalRecords?: number; products: ProductRecord[] } {
  const parsed = JSON.parse(body) as { cantidad_registros?: string; productos?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const items = Array.isArray(parsed) ? parsed : parsed.productos ?? [];
  const totalRecords = Number((Array.isArray(parsed) ? undefined : parsed.cantidad_registros) ?? 0);
    const products = items.reduce<ProductRecord[]>((accumulator, item) => {
      const stock = String(item.stock ?? '').trim();
      const stockValue = Number(stock.replace(',', '.'));
      const noComprable = String(item.no_comprable ?? '').toUpperCase();
      const rawPrice = String(item.precio ?? item.precio_anterior_con_iva ?? '').trim();

      accumulator.push({
        productName: String(item.descripcion_corta ?? '').trim() || String(item.descripcion_larga ?? '').trim(),
        price: rawPrice ? normalizePriceValue(rawPrice) : undefined,
        currency: inferCurrency(String(item.moneda ?? '$')),
        brand: String(item.marca ?? '').trim() || undefined,
        category: [item.rubro, item.subrubro].filter(Boolean).join(' / ') || undefined,
        description: String(item.descripcion_larga ?? item.comentarios ?? '').trim() || undefined,
        availability:
          noComprable === 'S'
            ? 'out_of_stock'
            : Number.isNaN(stockValue)
              ? 'unknown'
              : stockValue > 0
                ? 'in_stock'
                : 'out_of_stock',
        stock,
        sourceUrl: `${sourceUrl}?codigo=${encodeURIComponent(String(item.codigo ?? item.codigo_fabrica ?? ''))}`,
        imageUrl: buildAcesurImageUrl(String(item.nombre_foto ?? '').trim()),
        attributes: {
          oferta: String(item.oferta ?? ''),
          promocion: String(item.promocion ?? ''),
        },
        extractedAt: new Date().toISOString(),
        provider,
      });

      return accumulator;
    }, []);

  return { totalRecords, products };
}

export function parseAcesurFilterOptions(body: string): string[] {
  const parsed = JSON.parse(body) as Array<{ tipo?: string; codigo?: string }>;
  return parsed
    .filter((item) => String(item.tipo ?? '').toUpperCase() === 'B')
    .map((item) => String(item.codigo ?? '').trim())
    .filter(Boolean);
}

export async function extractAcesurProductsByRubro(
  rubros: string[],
  options: {
    uuid: string;
    seedUrl: string;
    provider: 'domain';
    maxItems: number;
    logger: Logger;
    customerCode?: string;
    crawlCategory: typeof crawlAcesurCategory;
  },
): Promise<ProductRecord[]> {
  const categorySeeds = rubros.length > 0 ? rubros.map((rubro) => ({ primerFiltro: rubro })) : [{ primerFiltro: '' }];
  const products: ProductRecord[] = [];

  for (const seed of categorySeeds) {
    if (products.length >= options.maxItems) {
      break;
    }

    try {
      const batch = await options.crawlCategory(
        options.uuid,
        seed,
        options.seedUrl,
        options.provider,
        options.maxItems - products.length,
        options.logger,
        options.customerCode,
      );

      if (batch.length === 0) {
        continue;
      }

      products.push(...batch);
    } catch (error) {
      options.logger.warn(`Acesur rubro fallido rubro=${seed.primerFiltro || 'todos'}: ${formatError(error)}`);
    }
  }

  return dedupeProducts(products).slice(0, options.maxItems);
}

async function crawlAcesurCategory(
  uuid: string,
  filters: { primerFiltro: string; segundoFiltro?: string; tercerFiltro?: string; cuartoFiltro?: string },
  sourceUrl: string,
  provider: 'domain',
  maxItems: number,
  logger: Logger,
  customerCode?: string,
): Promise<ProductRecord[]> {
  if (maxItems <= 0) {
    return [];
  }

  logger.log(`Acesur fetch page=1 rubro=${filters.primerFiltro || 'todos'}`);
  const firstPage = await fetchHtml(buildAcesurEndpoint(uuid, 1, filters, customerCode));
  const firstBatch = parseAcesurApi(firstPage.body, sourceUrl, provider);
  const total = Number(firstBatch.totalRecords ?? firstBatch.products.length);
  const totalPages = Math.max(1, Math.ceil(total / 20));
  const products = [...firstBatch.products];
  logger.log(`Acesur page=1 rubro=${filters.primerFiltro || 'todos'} total=${total} firstBatch=${firstBatch.products.length}`);

  for (let page = 2; page <= totalPages && products.length < maxItems; page += 1) {
    try {
      logger.log(`Acesur fetch page=${page} rubro=${filters.primerFiltro || 'todos'}`);
      const response = await fetchHtml(buildAcesurEndpoint(uuid, page, filters, customerCode));
      const batch = parseAcesurApi(response.body, sourceUrl, provider);
      if (batch.products.length === 0) {
        logger.warn(`Acesur empty page=${page} rubro=${filters.primerFiltro || 'todos'}`);
        break;
      }

      products.push(...batch.products);
    } catch (error) {
      logger.warn(`Fallo leyendo Acesur pagina ${page} (${filters.primerFiltro || 'todos'}): ${formatError(error)}`);
      break;
    }
  }

  return products;
}

async function fetchAcesurRubros(uuid: string, customerCode?: string): Promise<string[]> {
  const response = await fetchHtml(buildAcesurFilterEndpoint(uuid, 1, {}, customerCode));
  const rubros = parseAcesurFilterOptions(response.body);
  return rubros.filter((value) => value.toUpperCase() !== 'TODOS');
}

export function buildAcesurEndpoint(uuid: string, page: number, filters: { primerFiltro?: string; segundoFiltro?: string; tercerFiltro?: string; cuartoFiltro?: string } = {}, customerCode?: string): string {
  return buildAcesurUrl('app_obtener_productos.php', uuid, {
    pagina: String(page),
    order_by: '',
    tipo_orden: '',
    sucursal_pedido: '',
    primer_filtro: filters.primerFiltro ?? '',
    segundo_filtro: filters.segundoFiltro ?? '',
    tercer_filtro: filters.tercerFiltro ?? '',
    cuarto_filtro: filters.cuartoFiltro ?? '',
  }, customerCode);
}

function buildAcesurFilterEndpoint(
  uuid: string,
  filterNumber: 1 | 2 | 3 | 4,
  filters: { primero?: string; segundo?: string; tercero?: string; ultimo?: string } = {},
  customerCode?: string,
): string {
  return buildAcesurUrl(`app_obtener_buscador_${filterNumber}_filtro.php`, uuid, {
    ultimo: filters.ultimo ?? '',
    primero: filters.primero ?? '',
    segundo: filters.segundo ?? '',
    tercero: filters.tercero ?? '',
  }, customerCode);
}

function buildAcesurUrl(
  path: string,
  uuid: string,
  params: Record<string, string>,
  customerCode?: string,
): string {
  const query = new URLSearchParams({
    uuid,
    uuid_carro: `${uuid}|${customerCode ?? ''}`,
    codigo_cliente: customerCode ?? '',
    pais: '',
    ...params,
  });

  return `https://acesur.uy/app_endpoints_v4/${path}?${query.toString()}`;
}

function buildAcesurImageUrl(imageName: string): string | undefined {
  if (!imageName) {
    return undefined;
  }

  return `https://acesur.uy/fotos_articulos/${imageName}`;
}

export function extractSelvirArchiveSummary(body: string, finalUrl: string): { categoryLabel: string; totalResults?: number; totalPages?: number } | undefined {
  const root = parse(body);
  const title = cleanSelvirLabel(
    root.querySelector('h1')?.text
      ?? root.querySelector('.woocommerce-breadcrumb')?.text
      ?? root.querySelector('title')?.text,
  );

  if (!title) {
    return undefined;
  }

  const text = root.text ?? '';
  const resultsMatch =
    text.match(/mostrando\s+\d+\s*[–-]\s*\d+\s+de\s+(\d+)\s+resultados/i)
    ?? text.match(/mostrando\s+los\s+(\d+)\s+resultados/i);
  if (!resultsMatch) {
    return undefined;
  }
  const totalResults = resultsMatch ? Number(resultsMatch[1]) : undefined;
  const totalPages = totalResults ? Math.max(1, Math.ceil(totalResults / 30)) : undefined;

  if (/\/product\//i.test(finalUrl)) {
    return undefined;
  }

  return {
    categoryLabel: title,
    totalResults,
    totalPages,
  };
}

export function extractTaxitorPaginationSummary(body: string, finalUrl: string): {
  currentPage?: number;
  nextPageUrl?: string;
  lastPageUrl?: string;
} {
  const root = parse(body);
  const paginationLinks = root.querySelectorAll('ul.pagination a[href]');
  const currentPage = parseTaxitorPageNumber(
    cleanText(root.querySelector('ul.pagination li.active span')?.text)
      ?? cleanText(root.querySelector('li.active span')?.text),
  );

  let nextPageUrl: string | undefined;
  let lastPageUrl: string | undefined;
  let fallbackNextPage: { pageNumber: number; href: string } | undefined;

  for (const anchor of paginationLinks) {
    const href = normalizeTaxitorPaginationUrl(anchor.getAttribute('href'), finalUrl);
    if (!href) {
      continue;
    }

    const rel = (anchor.getAttribute('rel') ?? '').toLowerCase();
    const pageNumber = parseTaxitorPageNumber(anchor.getAttribute('data-ci-pagination-page'));
    const label = cleanText(anchor.text);

    if (rel.includes('next')) {
      nextPageUrl = href;
    }

    if (rel.includes('last') || label === '»') {
      lastPageUrl = href;
    }

    if (!nextPageUrl && typeof currentPage === 'number' && typeof pageNumber === 'number' && pageNumber > currentPage) {
      if (!fallbackNextPage || pageNumber < fallbackNextPage.pageNumber) {
        fallbackNextPage = { pageNumber, href };
      }
    }

    if (!lastPageUrl && typeof pageNumber === 'number' && label === '»') {
      lastPageUrl = href;
    }
  }

  return {
    currentPage,
    nextPageUrl: nextPageUrl ?? fallbackNextPage?.href,
    lastPageUrl,
  };
}

async function fetchSelvirArchivePage(categoryUrl: string, categoryLabel: string, page: number) {
  const body = new URLSearchParams({
    action: 'infinite_scroll_archive_products',
    category: categoryLabel,
    page: String(page),
    orderby: 'menu_order',
  }).toString();

  return fetchHtml('https://www.selvir.com.uy/wp-admin/admin-ajax.php', 3, {
    method: 'POST',
    body,
    headers: {
      origin: 'https://www.selvir.com.uy',
      referer: categoryUrl,
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
  });
}

export function parseSelvirAjaxResponse(body: string): { html: string; cantArticulos?: number; last?: boolean } {
  try {
    const parsed = JSON.parse(body) as { d?: unknown; cantArticulos?: unknown; last?: unknown };
    if (parsed && typeof parsed.d === 'string') {
      return {
        html: parsed.d,
        cantArticulos: typeof parsed.cantArticulos === 'number' ? parsed.cantArticulos : undefined,
        last: typeof parsed.last === 'boolean' ? parsed.last : undefined,
      };
    }
  } catch {
    // Selvir returns plain HTML on some responses; keep that path working.
  }

  return { html: body };
}

export function cleanSelvirLabel(value?: string): string | undefined {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return undefined;
  }

  let normalized = cleaned;
  while (/^(?:Inicio|Home|Productos)\s*\/\s*/i.test(normalized)) {
    normalized = normalized.replace(/^(?:Inicio|Home|Productos)\s*\/\s*/i, '');
  }

  return normalized
    .replace(/\s+Orden predeterminado.*$/i, '')
    .replace(/\s+archivos?\s*-\s*Selvir$/i, '')
    .replace(/\s*-\s*Selvir$/i, '')
    .trim() || undefined;
}

export function applyChapareiContextBrand(products: ProductRecord[], brandLabel?: string): ProductRecord[] {
  const normalizedBrandLabel = cleanText(brandLabel);
  if (!normalizedBrandLabel) {
    return products;
  }

  return products.map((product) => ({
    ...product,
    brand: normalizedBrandLabel,
  }));
}

export function applyGrFrenosContextBrand(products: ProductRecord[], brandLabel?: string): ProductRecord[] {
  return products.map((product) => ({
    ...product,
    compatibleBrands: mergeCompatibleBrands(product.compatibleBrands, brandLabel ? [brandLabel] : undefined),
  }));
}

export function extractChapareiBrandLabelFromUrl(
  value: string,
  brands: Array<{ brandId: string; brandLabel: string }>,
): string | undefined {
  const brandId = extractChapareiBrandId(value);
  if (!brandId) {
    return undefined;
  }

  return brands.find((brand) => brand.brandId === brandId)?.brandLabel;
}

function createChapareiSession() {
  let cookieHeader: string | undefined;

  return {
    async fetch(url: string): Promise<HttpResponseData> {
      const response = await fetchHtml(url, 5, {
        headers: cookieHeader
          ? {
              cookie: cookieHeader,
            }
          : undefined,
      });

      cookieHeader = mergeChapareiCookies(cookieHeader, response.headers['set-cookie']);
      return response;
    },
  };
}

function createCookieSession() {
  let cookieHeader: string | undefined;

  return {
    async fetch(url: string, init: HttpRequestInit = {}): Promise<HttpResponseData> {
      const response = await fetchHtml(url, 5, {
        ...init,
        headers: {
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          ...(init.headers ?? {}),
        },
      });
      cookieHeader = mergeChapareiCookies(cookieHeader, response.headers['set-cookie']);
      return response;
    },
  };
}

function mergeChapareiCookies(current: string | undefined, setCookieHeader: string | string[] | undefined): string | undefined {
  const jar = new Map<string, string>();

  if (current) {
    current.split(/;\s*/).forEach((entry) => {
      const index = entry.indexOf('=');
      if (index > 0) {
        jar.set(entry.slice(0, index), entry.slice(index + 1));
      }
    });
  }

  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  for (const cookie of cookies) {
    const pair = cookie.split(';', 1)[0]?.trim();
    const index = pair.indexOf('=');
    if (index > 0) {
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  if (jar.size === 0) {
    return current;
  }

  return Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

function buildChapareiAjaxPageUrl(pageUrl: string, page: number): string {
  const url = new URL(pageUrl);
  url.pathname = '/productos/includes/cargar_pagina_dinamica.php';
  url.searchParams.set('nro_pag', String(page));
  if (!url.searchParams.has('zona')) {
    url.searchParams.set('zona', '0');
  }
  if (!url.searchParams.has('order')) {
    url.searchParams.set('order', '255');
  }
  if (!url.searchParams.has('mo')) {
    url.searchParams.set('mo', '1');
  }

  return url.toString();
}

function isChapareiBrandHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/productos/' && !parsed.searchParams.has('m');
  } catch {
    return false;
  }
}

function extractChapareiCanonicalBrandUrl(html: string, baseUrl: string): string | undefined {
  const root = parse(html);
  const selected = root.querySelector('select#id_marca option[selected][value]') ?? root.querySelector('select#id_marca option[selected="selected"][value]');
  const brandId = cleanText(selected?.getAttribute('value'));
  if (!brandId || !/^\d+$/.test(brandId)) {
    return undefined;
  }

  try {
    return new URL(`/productos/?m=${brandId}`, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function mergeTextValues(previous?: string[], current?: string[]): string[] | undefined {
  const values = new Map<string, string>();
  for (const value of [...(previous ?? []), ...(current ?? [])]) {
    const cleaned = cleanText(value);
    if (cleaned) {
      values.set(cleaned.toLowerCase(), cleaned);
    }
  }
  return values.size > 0 ? Array.from(values.values()) : undefined;
}

function extractChapareiBrandId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const brandId = cleanText(url.searchParams.get('m') ?? undefined);
    return brandId && /^\d+$/.test(brandId) ? brandId : undefined;
  } catch {
    return undefined;
  }
}

function extractGrFrenosBrandId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/[?&]marcas=(\d+)---/i);
  return match?.[1];
}

function inferFenicioBrandSeed(value: string, site: 'cymaco' | 'familcar'): CatalogBrandSeed | undefined {
  try {
    const url = new URL(value);
    const rawLabel = site === 'cymaco'
      ? cleanText(url.searchParams.get('marca-comp') ?? undefined)
      : cleanText(url.pathname.split('/').filter(Boolean)[0]);
    if (!rawLabel || (site === 'familcar' && rawLabel === 'catalogo')) {
      return undefined;
    }

    const brandLabel = rawLabel
      .split('-')
      .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : '')
      .join(' ');
    return { brandLabel, sourceUrl: url.toString() };
  } catch {
    return undefined;
  }
}

function uniqueBrandEntries(values: CatalogBrandSeed[]): CatalogBrandSeed[] {
  const map = new Map<string, CatalogBrandSeed>();
  for (const value of values) {
    map.set(value.sourceUrl, value);
  }
  return Array.from(map.values());
}

function normalizeTaxitorPaginationUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function parseTaxitorPageNumber(value: string | undefined): number | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return undefined;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchHtmlWithRetry(url: string, init: HttpRequestInit = {}, attempts = 3): Promise<HttpResponseData> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchHtml(url, 5, init);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return response;
      }
      lastError = new Error(`HTTP ${response.statusCode} para ${url}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`No se pudo obtener ${url}`);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const safeConcurrency = Math.max(1, Math.min(concurrency, 20));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(safeConcurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}
