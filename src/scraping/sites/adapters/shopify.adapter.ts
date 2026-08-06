import { extractShopifyProducts } from '../../domain/new-catalog-sites';
import type { CatalogRequestContext, CatalogSiteConfig, DiscoveryResult } from '../types';
import { BaseCatalogAdapter } from './base.adapter';

export class ShopifyAdapter extends BaseCatalogAdapter {
  readonly platform = 'shopify' as const;

  override async discover(context: CatalogRequestContext): Promise<DiscoveryResult> {
    const discoveredUrls: string[] = [];
    const pages: DiscoveryResult['pages'] = [];

    for (let page = 1; page <= 100; page += 1) {
      const url = new URL('/products.json', `https://${context.site.hostname}`);
      url.searchParams.set('limit', '250');
      url.searchParams.set('page', String(page));
      const response = await context.fetch(url.toString());
      const extracted = extractShopifyProducts(response.body, `https://${context.site.hostname}`, 'domain');
      const pageUrls = extracted.products.map((product) => product.sourceUrl).filter((value): value is string => Boolean(value));
      pages.push({ listingUrl: context.site.seedUrls[0] ?? url.toString(), pageUrl: url.toString(), pageNumber: page, productUrls: pageUrls, categoryUrls: [], isLastPage: extracted.received === 0 });
      discoveredUrls.push(...pageUrls);
      if (extracted.received === 0 || extracted.received < 250) {
        break;
      }
    }

    const uniqueUrls = Array.from(new Set(discoveredUrls));
    return { siteId: context.site.id, categories: context.site.seedUrls, pages, discoveredUrls, uniqueUrls, duplicates: discoveredUrls.length - uniqueUrls.length, errors: [] };
  }

  protected override extractProductsFromBody(site: CatalogSiteConfig, html: string, pageUrl: string) {
    const extracted = extractShopifyProducts(html, pageUrl, 'domain');
    return extracted.products.length > 0 ? extracted.products : super.extractProductsFromBody(site, html, pageUrl);
  }
}
