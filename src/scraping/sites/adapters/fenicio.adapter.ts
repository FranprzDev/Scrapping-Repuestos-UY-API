import { extractFenicioProducts } from '../../domain/new-catalog-sites';
import type { CatalogSiteConfig } from '../types';
import { BaseCatalogAdapter } from './base.adapter';

export class FenicioAdapter extends BaseCatalogAdapter {
  readonly platform = 'fenicio' as const;

  protected override extractProductsFromBody(site: CatalogSiteConfig, html: string, pageUrl: string) {
    const products = extractFenicioProducts(html, pageUrl, 'domain');
    return products.length > 0 ? products : super.extractProductsFromBody(site, html, pageUrl);
  }
}
