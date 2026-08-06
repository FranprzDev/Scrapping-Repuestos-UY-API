import type { CatalogAdapter, CatalogPlatform } from '../types';
import { FenicioAdapter } from './fenicio.adapter';
import { GenericHtmlPaginationAdapter } from './generic-html-pagination.adapter';
import { JsonApiAdapter } from './json-api.adapter';
import { MercadoLibreApiAdapter } from './mercado-libre-api.adapter';
import { ShopifyAdapter } from './shopify.adapter';
import { WooCommerceAdapter } from './woocommerce.adapter';

export function createCatalogAdapter(platform: CatalogPlatform): CatalogAdapter {
  switch (platform) {
    case 'woocommerce':
      return new WooCommerceAdapter();
    case 'shopify':
      return new ShopifyAdapter();
    case 'fenicio':
      return new FenicioAdapter();
    case 'json-api':
      return new JsonApiAdapter();
    case 'mercado-libre-api':
      return new MercadoLibreApiAdapter();
    case 'generic-html':
    default:
      return new GenericHtmlPaginationAdapter();
  }
}

export { FenicioAdapter } from './fenicio.adapter';
export { GenericHtmlPaginationAdapter } from './generic-html-pagination.adapter';
export { JsonApiAdapter } from './json-api.adapter';
export { MercadoLibreApiAdapter } from './mercado-libre-api.adapter';
export { ShopifyAdapter } from './shopify.adapter';
export { WooCommerceAdapter } from './woocommerce.adapter';
