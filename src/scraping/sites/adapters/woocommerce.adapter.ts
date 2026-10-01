import { BaseCatalogAdapter } from './base.adapter';
import { parse, type HTMLElement } from 'node-html-parser';
import type { ProductRecord } from '../../interfaces/scraping.types';
import { cleanText, inferCurrency, normalizePriceValue, parsePriceNumber, resolveAvailability } from '../../domain/product-quality';
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

  const sku = normalizeRomySku(nodeText(summary.querySelector('.sku')));
  const priceRoot = summary.querySelector('.price') ?? summary;
  const regularPriceText = nodeText(priceRoot.querySelector('del .woocommerce-Price-amount, del'));
  const salePriceText = nodeText(priceRoot.querySelector('ins .woocommerce-Price-amount, ins'));
  const amountTexts = priceRoot.querySelectorAll('.woocommerce-Price-amount').map(nodeText).filter((value): value is string => Boolean(value));
  const currentPriceText = salePriceText ?? amountTexts.at(-1) ?? nodeText(priceRoot);
  const regularPrice = normalizePriceValue(regularPriceText ?? currentPriceText);
  const salePrice = normalizePriceValue(salePriceText);
  const price = salePrice ?? normalizePriceValue(currentPriceText);
  const regularPriceAmount = parsePriceNumber(regularPrice);
  const salePriceAmount = parsePriceNumber(salePrice);
  const isOffer = regularPriceAmount !== undefined
    && salePriceAmount !== undefined
    && salePriceAmount < regularPriceAmount;
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
  const imageUrls = extractRomyImages(root, pageUrl);

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

function normalizeRomySku(value: string | undefined): string | undefined {
  if (!value || /^(?:n\s*[/.]?\s*d|n\s*[/.]?\s*a|s[/.]?d|sin\s+(?:dato|datos|sku)|no\s+disponible|[-–—])$/i.test(value)) {
    return undefined;
  }
  return value;
}

function extractRomyImages(root: HTMLElement, pageUrl: string): string[] {
  const candidates: string[] = [];
  const galleryItems = root.querySelectorAll([
    '.woocommerce-product-gallery__image',
    '.woocommerce-product-gallery .swiper-slide',
    '.woocommerce-product-gallery .slick-slide',
    '.product-gallery__image',
    '.product-images__item',
  ].join(', '));

  for (const item of galleryItems) {
    const preferred = firstValidImageCandidate([
      item.querySelector('a[href]')?.getAttribute('href'),
      ...imageCandidates(item.querySelector('img')),
    ], pageUrl);
    if (preferred) candidates.push(preferred);
  }

  if (candidates.length === 0) {
    const gallery = root.querySelector('.woocommerce-product-gallery, .product-gallery, .product-images, [class*="product-gallery"]');
    gallery?.querySelectorAll('a[href], img').forEach((element) => {
      const preferred = firstValidImageCandidate([
        element.tagName === 'A' ? element.getAttribute('href') : undefined,
        ...imageCandidates(element.tagName === 'IMG' ? element : element.querySelector('img')),
      ], pageUrl);
      if (preferred) candidates.push(preferred);
    });
  }

  if (candidates.length === 0) {
    const socialImage = root.querySelector('meta[property="og:image"]')?.getAttribute('content')
      ?? root.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
    const fallback = firstValidImageCandidate([socialImage], pageUrl);
    if (fallback) candidates.push(fallback);
  }

  return Array.from(new Set(candidates));
}

function imageCandidates(image: HTMLElement | null): Array<string | undefined> {
  if (!image) return [];
  const srcset = image.getAttribute('data-srcset') ?? image.getAttribute('srcset');
  const largestSrcsetImage = srcset?.split(',').at(-1)?.trim().split(/\s+/, 1)[0];
  return [
    image.getAttribute('data-large_image'),
    image.getAttribute('data-full'),
    image.getAttribute('data-original'),
    image.getAttribute('data-lazy-src'),
    image.getAttribute('data-src'),
    largestSrcsetImage,
    image.getAttribute('src'),
  ];
}

function firstValidImageCandidate(values: Array<string | undefined>, pageUrl: string): string | undefined {
  for (const value of values) {
    if (!value || /^data:/i.test(value)) continue;
    try {
      const url = new URL(value, pageUrl).toString();
      if (!isNonProductImage(url)) {
        return url;
      }
    } catch {
      // Ignore malformed image URLs.
    }
  }
  return undefined;
}

function isNonProductImage(url: string): boolean {
  return /(?:^|[\/_.-])(?:logo|logotipo|placeholder|no[-_]?image|sin[-_]?imagen|favicon|icons?|sprite|loader|loading|spinner|pixel|blank|banner|header|footer|whatsapp|facebook|instagram|related|relacionad[oa]s?)(?:[\/_.-]|$)/i.test(url)
    || /medios?[-_]?pago/i.test(url);
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
