import { parse } from 'node-html-parser';
import type { ProductRecord } from '../../interfaces/scraping.types';
import { cleanText } from '../../domain/product-quality';
import type { CatalogSiteConfig } from '../types';
import { BaseCatalogAdapter } from './base.adapter';

export class GenericHtmlPaginationAdapter extends BaseCatalogAdapter {
  readonly platform = 'generic-html' as const;

  protected override extractProductsFromBody(site: CatalogSiteConfig, html: string, pageUrl: string): ProductRecord[] {
    const generic = super.extractProductsFromBody(site, html, pageUrl);
    if (generic.length > 0 || site.id !== 'container') {
      return generic;
    }

    const root = parse(html);
    const text = cleanText(root.structuredText || root.text) ?? '';
    const sku = cleanText(text.match(/N[º°o]?\s*Pieza\s*:\s*([^\n\r]+)/i)?.[1]);
    const price = cleanText(text.match(/Precio\s*:\s*\$?\s*([\d.,]+)/i)?.[1]);
    const headings = root.querySelectorAll('h1,h2,h3')
      .map((heading) => cleanText(heading.structuredText || heading.text))
      .filter((value): value is string => typeof value === 'string' && !/^(?:producto|bujia)$/i.test(value));
    const productName = headings.sort((left, right) => right.length - left.length)[0]
      ?? cleanText(root.querySelector('title')?.text);

    if (!productName || !price) {
      return [];
    }

    const imageUrl = root.querySelector('img[src*="Product"], img[src*="producto"], .product img[src]')?.getAttribute('src');
    return [{
      productName,
      price,
      currency: 'UYU',
      sku,
      description: productName,
      availability: /agregar al carrito/i.test(text) ? 'disponible' : undefined,
      sourceUrl: pageUrl,
      imageUrl: imageUrl ? new URL(imageUrl, pageUrl).toString() : undefined,
      provider: 'domain',
      extractedAt: new Date().toISOString(),
    }];
  }
}
