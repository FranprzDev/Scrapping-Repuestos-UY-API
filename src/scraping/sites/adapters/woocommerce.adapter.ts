import { BaseCatalogAdapter } from './base.adapter';
import { parse, type HTMLElement } from 'node-html-parser';
import type { ProductRecord } from '../../interfaces/scraping.types';
import { cleanText, inferCurrency, normalizePriceValue, resolveAvailability } from '../../domain/product-quality';
import type { CatalogSiteConfig } from '../types';

export class WooCommerceAdapter extends BaseCatalogAdapter {
  readonly platform = 'woocommerce' as const;

  protected override extractProductsFromBody(site: CatalogSiteConfig, html: string, pageUrl: string): ProductRecord[] {
    if (site.id === 'romy' && site.productUrlPatterns.some((pattern) => pattern.test(pageUrl))) {
      const product = extractRomyProduct(html, pageUrl);
      return product ? [product] : super.extractProductsFromBody(site, html, pageUrl);
    }
    return super.extractProductsFromBody(site, html, pageUrl);
  }
}

export function extractRomyProduct(html: string, pageUrl: string): ProductRecord | undefined {
  const root = parse(html);
  const summary = root.querySelector('.summary') ?? root.querySelector('main') ?? root;
  const productName = nodeText(summary.querySelector('h1.product_title, h1'));
  if (!productName) return undefined;

  const sku = nodeText(summary.querySelector('.sku'));
  const priceRoot = summary.querySelector('.price') ?? summary;
  const regularPriceText = nodeText(priceRoot.querySelector('del .woocommerce-Price-amount, del'));
  const salePriceText = nodeText(priceRoot.querySelector('ins .woocommerce-Price-amount, ins'));
  const amountTexts = priceRoot.querySelectorAll('.woocommerce-Price-amount').map(nodeText).filter((value): value is string => Boolean(value));
  const currentPriceText = salePriceText ?? amountTexts.at(-1) ?? nodeText(priceRoot);
  const regularPrice = normalizePriceValue(regularPriceText ?? currentPriceText);
  const salePrice = normalizePriceValue(salePriceText);
  const price = salePrice ?? normalizePriceValue(currentPriceText);
  const isOffer = Boolean(salePrice && regularPrice && salePrice !== regularPrice)
    || Boolean(root.querySelector('.onsale'));
  const fullText = cleanText(summary.structuredText || summary.text) ?? '';
  const availability = resolveAvailability(fullText);
  const colors = extractColors(summary);
  const colorStock = extractVariationStock(summary);
  const attributes: Record<string, string> = {
    isOffer: String(isOffer),
    ...(regularPrice ? { regularPrice } : {}),
    ...(salePrice ? { salePrice } : {}),
    ...(colors.length ? { colors: colors.join(' | ') } : {}),
    ...(Object.keys(colorStock).length ? { colorStock: JSON.stringify(colorStock) } : {}),
  };
  const imageUrls = Array.from(new Set(
    root.querySelectorAll('.woocommerce-product-gallery img').flatMap((image) => [
      image.getAttribute('data-large_image'),
      image.getAttribute('data-src'),
      image.getAttribute('src'),
    ]).filter((value): value is string => Boolean(value)),
  ));

  return {
    productName,
    price,
    currency: inferCurrency([salePriceText, regularPriceText, currentPriceText].filter(Boolean).join(' ')),
    sku,
    availability,
    stock: availability === 'out_of_stock' ? '0' : undefined,
    sourceUrl: pageUrl,
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length ? imageUrls : undefined,
    attributes,
    extractedAt: new Date().toISOString(),
    provider: 'domain',
  };
}

function nodeText(node: HTMLElement | null | undefined): string | undefined {
  return cleanText(node?.structuredText || node?.text);
}

function extractColors(root: HTMLElement): string[] {
  const values = new Map<string, string>();
  root.querySelectorAll('select[name*="attribute_"] option').forEach((option) => {
    const value = cleanText(option.getAttribute('value'));
    const label = nodeText(option);
    if (value && label) values.set(label.toLocaleLowerCase('es'), label);
  });
  return Array.from(values.values());
}

function extractVariationStock(root: HTMLElement): Record<string, string> {
  const encoded = root.querySelector('form.variations_form')?.getAttribute('data-product_variations');
  if (!encoded) return {};
  try {
    const variations = JSON.parse(encoded) as Array<{
      attributes?: Record<string, string>;
      is_in_stock?: boolean;
      variation_is_active?: boolean;
    }>;
    const stock: Record<string, string> = {};
    for (const variation of variations) {
      const color = Object.entries(variation.attributes ?? {})
        .find(([name]) => /color/i.test(name))?.[1];
      if (color) stock[color] = variation.is_in_stock !== false && variation.variation_is_active !== false ? 'in_stock' : 'out_of_stock';
    }
    return stock;
  } catch {
    return {};
  }
}
