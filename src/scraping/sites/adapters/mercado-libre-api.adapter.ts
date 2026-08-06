import type { CatalogRequestContext, DiscoveryResult, ExtractionResult } from '../types';
import { JsonApiAdapter } from './json-api.adapter';

export interface MercadoLibreOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  redirectUri?: string;
}

export interface MercadoLibreSearchParams {
  siteId: 'MLU';
  query?: string;
  categoryId?: string;
  offset?: number;
  limit?: number;
}

export class MercadoLibreApiAdapter extends JsonApiAdapter {
  override readonly platform = 'mercado-libre-api' as const;

  override async discover(_context: CatalogRequestContext): Promise<DiscoveryResult> {
    return {
      siteId: 'mercado-libre-uy',
      categories: [],
      pages: [],
      discoveredUrls: [],
      uniqueUrls: [],
      duplicates: 0,
      errors: [{
        phase: 'discovery',
        message: 'Mercado Libre debe integrarse mediante API oficial y OAuth; HTML scraping deshabilitado.',
      }],
    };
  }

  override async extract(_context: CatalogRequestContext, _urls: string[]): Promise<ExtractionResult> {
    return {
      siteId: 'mercado-libre-uy',
      products: [],
      rejected: [],
      errors: [{
        phase: 'extraction',
        message: 'Interfaz base lista; falta implementar cliente OAuth/API sin tokens reales.',
      }],
    };
  }

  buildSearchUrl(params: MercadoLibreSearchParams): string {
    const url = new URL(`/sites/${params.siteId}/search`, 'https://api.mercadolibre.com');
    if (params.query) url.searchParams.set('q', params.query);
    if (params.categoryId) url.searchParams.set('category', params.categoryId);
    if (params.offset !== undefined) url.searchParams.set('offset', String(params.offset));
    if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
    return url.toString();
  }
}
