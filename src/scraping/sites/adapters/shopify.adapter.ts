import { extractShopifyProducts } from '../../domain/new-catalog-sites';
import type { CatalogRequestContext, CatalogSiteConfig, DiscoveryResult } from '../types';
import { BaseCatalogAdapter } from './base.adapter';

export class ShopifyAdapter extends BaseCatalogAdapter {
  readonly platform = 'shopify' as const;

  override async discover(context: CatalogRequestContext): Promise<DiscoveryResult> {
    const discoveredUrls: string[] = [];
    const pages: DiscoveryResult['pages'] = [];
    const maxPages = Math.min(context.maxPages ?? Number.POSITIVE_INFINITY, 100);
    const maxProducts = context.maxProducts ?? Number.POSITIVE_INFINITY;
    let terminationReason: DiscoveryResult['terminationReason'] = 'catalog_end';

    for (let page = 1; page <= maxPages; page += 1) {
      const url = new URL('/products.json', `https://${context.site.hostname}`);
      url.searchParams.set('limit', '250');
      url.searchParams.set('page', String(page));
      const response = await context.fetch(url.toString());
      const extracted = extractShopifyProducts(response.body, `https://${context.site.hostname}`, 'domain');
      const pageUrls = extracted.products.map((product) => product.sourceUrl).filter((value): value is string => Boolean(value));
      const remainingProducts = Math.max(maxProducts - discoveredUrls.length, 0);
      const auditedPageUrls = pageUrls.slice(0, remainingProducts);
      pages.push({ listingUrl: context.site.seedUrls[0] ?? url.toString(), pageUrl: url.toString(), pageNumber: page, productUrls: auditedPageUrls, categoryUrls: [], isLastPage: extracted.received === 0 });
      discoveredUrls.push(...auditedPageUrls);
      if (auditedPageUrls.length < pageUrls.length || (discoveredUrls.length >= maxProducts && page < 100)) {
        terminationReason = 'max_products';
        break;
      }
      if (extracted.received === 0 || extracted.received < 250) {
        break;
      }
    }
    if (terminationReason === 'catalog_end' && pages.length >= maxPages && maxPages < 100) {
      terminationReason = 'max_pages';
    }

    const uniqueUrls = Array.from(new Set(discoveredUrls));
    return {
      siteId: context.site.id,
      categories: context.site.seedUrls,
      pages,
      discoveredUrls,
      uniqueUrls,
      duplicates: discoveredUrls.length - uniqueUrls.length,
      errors: [],
      limited: terminationReason !== 'catalog_end',
      terminationReason,
      requestedLimits: {
        ...(context.maxPages !== undefined ? { maxPages: context.maxPages } : {}),
        ...(context.maxProducts !== undefined ? { maxProducts: context.maxProducts } : {}),
      },
      pagesAudited: pages.length,
      productsAudited: uniqueUrls.length,
    };
  }

  protected override extractProductsFromBody(site: CatalogSiteConfig, html: string, pageUrl: string) {
    const extracted = extractShopifyProducts(html, pageUrl, 'domain');
    return extracted.products.length > 0 ? extracted.products : super.extractProductsFromBody(site, html, pageUrl);
  }
}
