import { parse } from 'node-html-parser';
import type { ProductRecord } from '../../interfaces/scraping.types';
import { cleanText } from '../../domain/product-quality';
import type { CatalogSiteConfig } from '../types';
import { BaseCatalogAdapter } from './base.adapter';

export class GenericHtmlPaginationAdapter extends BaseCatalogAdapter {
  readonly platform = 'generic-html' as const;

  protected override extractProductsFromBody(site: CatalogSiteConfig, html: string, pageUrl: string): ProductRecord[] {
    if (site.id === 'mercadodelrepuesto') {
      return extractMercadoDelRepuestoProduct(html, pageUrl);
    }

    const generic = super.extractProductsFromBody(site, html, pageUrl);
    if (generic.length > 0 || site.id !== 'container') {
      return generic;
    }

    const root = parse(html);
    const text = cleanText(root.structuredText || root.text) ?? '';
    const sku = cleanText(text.match(/N[º°o]?\s*Pieza\s*:\s*([^\s<]+)/i)?.[1]);
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

function extractMercadoDelRepuestoProduct(html: string, pageUrl: string): ProductRecord[] {
  const root = parse(html);
  const text = cleanText(root.structuredText || root.text) ?? '';
  const productName = cleanText(root.querySelector('h1')?.structuredText || root.querySelector('h1')?.text);
  const sku = cleanText(
    text.match(/C[ÓO]D\.\s*([A-Z0-9._/-]+)/i)?.[1]
      ?? text.match(/C[ÓO]DIGO\s*([A-Z0-9._/-]+)/i)?.[1],
  );

  const nextPrice = html.match(/\\?"precio\\?"\s*:\s*(\d+(?:\.\d+)?)/i)?.[1];
  const visiblePrice = text.match(/\$\s*([\d.]+)(?=\s*≈\s*US\$)/i)?.[1];
  const price = normalizeUyPrice(nextPrice ?? visiblePrice);

  if (!productName || !price) {
    return [];
  }

  const rawImages = root.querySelectorAll('img[src]')
    .map((image) => image.getAttribute('src'))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => {
      try {
        return new URL(value, pageUrl).toString();
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => /^https?:\/\//i.test(value))
    .filter((value) => !/(?:facebook\.com\/tr|logo-mdr|mp-logo|icon\.png)/i.test(value));

  const imageUrls = Array.from(new Set(rawImages));
  const preferredImage = imageUrls.find((value) => /\/fotos\//i.test(value)) ?? imageUrls[0];

  const description = cleanText(text.match(/Descripci[oó]n\s+([\s\S]*?)\s+Caracter[ií]sticas/i)?.[1]);
  const category = cleanText(description?.match(/Rubro:\s*([^|]+)/i)?.[1]);
  const subcategory = cleanText(description?.match(/Subrubro:\s*([^|]+)/i)?.[1]);

  const compatibleVehicles = Array.from(new Set(
    root.querySelectorAll('span[class*="flex-col"][class*="border"]')
      .map((node) => cleanText(node.structuredText || node.text))
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .filter((value) => !/^C[ÓO]D\.?/i.test(value)),
  ));

  const availability = /\bDisponible\b/i.test(text)
    ? 'disponible'
    : /\b(?:Agotado|Sin stock|No disponible)\b/i.test(text)
      ? 'no disponible'
      : undefined;

  return [{
    productName,
    price,
    currency: 'UYU',
    sku,
    category,
    description,
    availability,
    sourceUrl: pageUrl,
    imageUrl: preferredImage,
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    compatibleVehicles: compatibleVehicles.length > 0 ? compatibleVehicles : undefined,
    attributes: subcategory ? { subrubro: subcategory } : undefined,
    provider: 'domain',
    extractedAt: new Date().toISOString(),
  }];
}

function normalizeUyPrice(value?: string): string | undefined {
  const clean = cleanText(value);
  if (!clean) {
    return undefined;
  }
  if (/^\d{1,3}(?:\.\d{3})+$/.test(clean)) {
    return clean.replace(/\./g, '');
  }
  return clean;
}
