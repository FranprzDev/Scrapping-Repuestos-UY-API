import type { ProductRecord } from '../../interfaces/scraping.types';
import { cleanText, normalizePriceValue } from '../../domain/product-quality';
import type { CatalogPlatform, CatalogSiteConfig } from '../types';
import { BaseCatalogAdapter } from './base.adapter';

export class JsonApiAdapter extends BaseCatalogAdapter {
  readonly platform: CatalogPlatform = 'json-api';

  protected override extractProductsFromBody(site: CatalogSiteConfig, body: string, pageUrl: string): ProductRecord[] {
    try {
      const parsed = JSON.parse(body) as unknown;
      return collectJsonProducts(parsed, pageUrl);
    } catch {
      return super.extractProductsFromBody(site, body, pageUrl);
    }
  }
}

function collectJsonProducts(input: unknown, pageUrl: string): ProductRecord[] {
  const products: ProductRecord[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const record = value as Record<string, unknown>;
    const name = text(record.name) ?? text(record.title) ?? text(record.productName);
    const price = normalizePriceValue(text(record.price) ?? text(record.salePrice) ?? text(record.amount));
    if (name) {
      products.push({
        productName: name,
        price,
        currency: text(record.currency) ?? 'UYU',
        sku: text(record.sku) ?? text(record.code),
        brand: text(record.brand),
        imageUrl: text(record.imageUrl) ?? text(record.image),
        sourceUrl: text(record.url) ?? pageUrl,
        availability: record.available === false ? 'out_of_stock' : 'in_stock',
        extractedAt: new Date().toISOString(),
        provider: 'domain',
      });
    }
    Object.values(record).forEach(visit);
  };
  visit(input);
  return products;
}

function text(value: unknown): string | undefined {
  return cleanText(typeof value === 'string' || typeof value === 'number' ? String(value) : undefined);
}
