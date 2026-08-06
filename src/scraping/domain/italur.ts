import { HTMLElement, parse } from 'node-html-parser';
import { ProductRecord, ProviderName } from '../interfaces/scraping.types';
import { cleanText, normalizeComparableText, normalizePriceValue } from './product-quality';

export const ITALUR_PRODUCT_PATH = /^\/producto\/[^/?#]+\/?$/i;
export const ITALUR_CATEGORY_PATH = /^\/categoria-producto(?:\/[^/?#]+)*\/?$/i;
export const ITALUR_LEGACY_CATEGORY_PATH = /^\/product-category(?:\/[^/?#]+)*(?:\/page\/\d+)?\/?$/i;
export const ITALUR_SHOP_PATH = /^\/tienda(?:\/page\/\d+)?\/?$/i;

const INFO_PATH_PATTERN = /\/(?:carrito|carrito-compras|checkout|finalizar-compra|mi-cuenta|contacto|empresa|blog|condiciones|wp-admin|wp-json|feed)(?:\/|$)/i;
const UTILITY_QUERY_PATTERN = /[?&](?:add-to-cart|s|orderby|min_price|max_price|filter_|rating_filter|post_type)=/i;
const IMAGE_PATTERN = /\.(?:avif|webp|jpe?g|png|gif)(?:[?#]|$)/i;
const NON_PRODUCT_IMAGE_PATTERN = /(?:logo|banner|placeholder|sin[-_]?imagen|no[-_]?image|header|footer|sprite|icon|favicon|loading|loader|blank|default|pixel|ajax-search-for-woocommerce)/i;
const VEHICLE_BRANDS = ['Chevrolet', 'Isuzu', 'JMC', 'JAC', 'Foton'];
const VEHICLE_MODELS = [
  'Agile',
  'Aveo',
  'C10',
  'C20',
  'Celta',
  'Chevette',
  'Classic',
  'Cobalt',
  'Colorado',
  'Corsa',
  'Cruze',
  'D20',
  'D40',
  'D-Max',
  'Dmax',
  'Gemini',
  'Kadett',
  'Mega',
  'Monza',
  'Montana',
  'N720',
  'N800',
  'N900',
  'NKR',
  'NLR',
  'Onix',
  'Prisma',
  'S10',
  'Silverado',
  'TF',
  'Tracker',
];

type JsonRecord = Record<string, unknown>;
type JsonLdProduct = {
  name?: unknown;
  sku?: unknown;
  description?: unknown;
  image?: unknown;
  offers?: Array<{ price?: unknown; priceCurrency?: unknown; availability?: unknown }> | { price?: unknown; priceCurrency?: unknown; availability?: unknown };
};

export interface ItalurListingSummary {
  currentPage?: number;
  lastPage?: number;
  nextPageUrl?: string;
}

export function isItalurProductUrl(value: string): boolean {
  try {
    return ITALUR_PRODUCT_PATH.test(new URL(value).pathname);
  } catch {
    return ITALUR_PRODUCT_PATH.test(value);
  }
}

export function isItalurListingUrl(value: string): boolean {
  try {
    const pathname = new URL(value).pathname;
    return ITALUR_SHOP_PATH.test(pathname) || ITALUR_CATEGORY_PATH.test(pathname) || ITALUR_LEGACY_CATEGORY_PATH.test(pathname);
  } catch {
    return ITALUR_SHOP_PATH.test(value) || ITALUR_CATEGORY_PATH.test(value) || ITALUR_LEGACY_CATEGORY_PATH.test(value);
  }
}

export function canonicalizeItalurUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!/^https?:$/i.test(url.protocol) || !/^(?:www\.)?italur\.com$/i.test(url.hostname)) return undefined;
    if (INFO_PATH_PATTERN.test(url.pathname) || UTILITY_QUERY_PATTERN.test(url.search)) return undefined;
    url.search = '';
    url.hash = '';
    url.hostname = 'www.italur.com';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (url.pathname === '/tienda' || url.pathname.startsWith('/tienda/page/')) {
      url.pathname += '/';
    }
    if (url.pathname.startsWith('/product-category/')) {
      url.pathname += '/';
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function normalizeItalurPrice(value?: string): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) return undefined;
  const numeric = cleaned
    .replace(/(?:\$U|\$|UYU)/gi, '')
    .replace(/\s+/g, '')
    .match(/\d[\d.,]*/)?.[0];
  if (!numeric) return undefined;
  const decimalMatch = numeric.match(/^(.*),(\d{1,2})$/);
  const integerPart = decimalMatch?.[1] ?? numeric;
  const decimalPart = decimalMatch?.[2];
  if (!integerPart.includes('.')) return decimalPart ? `${integerPart}.${decimalPart}` : integerPart;
  if (/^\d{1,3}(?:\.\d{3})+$/.test(integerPart)) {
    const normalizedInteger = integerPart.replace(/\./g, '');
    return decimalPart ? `${normalizedInteger}.${decimalPart}` : normalizedInteger;
  }
  return normalizePriceValue(cleaned);
}

export function extractItalurProductUrls(html: string, pageUrl: string): string[] {
  const root = parse(html);
  const urls = root.querySelectorAll('a[href]').flatMap((anchor) => {
    const normalized = normalizeUrl(anchor.getAttribute('href'), pageUrl);
    const canonical = normalized ? canonicalizeItalurUrl(normalized) : undefined;
    return canonical && isItalurProductUrl(canonical) ? [canonical] : [];
  });
  return uniqueStrings(urls);
}

export function extractItalurCategoryUrls(html: string, pageUrl: string): string[] {
  const root = parse(html);
  const urls = root.querySelectorAll('a[href]').flatMap((anchor) => {
    const normalized = normalizeUrl(anchor.getAttribute('href'), pageUrl);
    const canonical = normalized ? canonicalizeItalurUrl(normalized) : undefined;
    return canonical && isItalurListingUrl(canonical) ? [canonical] : [];
  });
  return uniqueStrings(urls);
}

export function extractItalurListingSummary(html: string, pageUrl: string): ItalurListingSummary {
  const root = parse(html);
  const pageNumbers = root.querySelectorAll('.page-numbers, nav.woocommerce-pagination a, nav.woocommerce-pagination span')
    .map((element) => parsePageNumberLabel(element.text))
    .filter((value): value is number => typeof value === 'number');
  const currentPage = parsePageNumberLabel(root.querySelector('.page-numbers.current')?.text) ?? pageNumberFromUrl(pageUrl);
  const lastPage = pageNumbers.length > 0 ? Math.max(...pageNumbers) : currentPage;
  const nextPageUrl = firstNonEmpty(
    root.querySelectorAll('a[href]').map((anchor) => {
      const rel = cleanText(anchor.getAttribute('rel'))?.toLowerCase();
      const text = normalizeComparableText(anchor.text);
      const classes = cleanText(anchor.getAttribute('class')) ?? '';
      if (rel !== 'next' && !classes.includes('next') && text !== 'siguiente' && text !== 'next') return undefined;
      const canonical = canonicalizeItalurUrl(normalizeUrl(anchor.getAttribute('href'), pageUrl) ?? '');
      return canonical && isItalurListingUrl(canonical) ? canonical : undefined;
    }),
  );
  return { currentPage, lastPage, nextPageUrl };
}

function parsePageNumberLabel(value?: string): number | undefined {
  const text = cleanText(value);
  if (!text || !/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractItalurListProducts(html: string, pageUrl: string, provider: ProviderName): ProductRecord[] {
  const root = parse(html);
  return root.querySelectorAll('li.type-product, .products .product').flatMap((card) => {
    const sourceUrl = canonicalizeItalurUrl(normalizeUrl(card.querySelector('a[href*="/producto/"]')?.getAttribute('href'), pageUrl) ?? '');
    const productName = cleanText(card.querySelector('.woocommerce-loop-product__title, h2, h3')?.text);
    const rawPrice = cleanText(card.querySelector('.price, .woocommerce-Price-amount')?.text);
    if (!sourceUrl || !productName || !rawPrice) return [];
    const sku = cleanText(card.querySelector('[data-product_sku]')?.getAttribute('data-product_sku'));
    const imageUrls = extractImages(card, pageUrl);
    const availability = resolveItalurAvailability(card);
    return [{
      productName,
      price: normalizeItalurPrice(rawPrice),
      currency: 'UYU',
      sku,
      category: categoryFromClasses(card),
      imageUrl: imageUrls[0],
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      sourceUrl,
      availability,
      ...inferItalurCompatibility([productName, categoryFromClasses(card)].filter(Boolean).join(' ')),
      extractedAt: new Date().toISOString(),
      provider,
    }];
  });
}

export function extractItalurDetail(html: string, pageUrl: string, provider: ProviderName): ProductRecord | undefined {
  const sourceUrl = canonicalizeItalurUrl(pageUrl);
  if (!sourceUrl || !isItalurProductUrl(sourceUrl)) return undefined;
  const root = parse(html);
  const detailRoot = firstElement(root, ['div.product', '.type-product', 'main', 'article']) ?? root;
  const summaryRoot = detailRoot.querySelector('.summary, .product_meta') ?? detailRoot;
  const jsonLd = extractJsonLdProduct(root);
  const offer = Array.isArray(jsonLd?.offers) ? jsonLd?.offers[0] : jsonLd?.offers;
  const productName = cleanText(detailRoot.querySelector('h1.product_title, h1')?.text) ?? asText(jsonLd?.name);
  if (!productName) return undefined;
  const rawPrice = cleanText(detailRoot.querySelector('.summary .price, p.price, .woocommerce-Price-amount')?.text) ?? asText(offer?.price);
  const description = cleanDescription(
    cleanText(root.querySelector('#tab-description, .woocommerce-product-details__short-description')?.text)
      ?? asText(jsonLd?.description),
  );
  const sku = cleanSku(cleanText(summaryRoot.querySelector('[data-product_sku]')?.getAttribute('data-product_sku'))
    ?? cleanText(summaryRoot.querySelector('.sku')?.text)
    ?? cleanText(detailRoot.querySelector('.product_meta .sku')?.text))
    ?? asText(jsonLd?.sku)
    ?? codeFromDescription(description);
  const detailImages = extractDetailImages(detailRoot, sourceUrl);
  const imageUrls = detailImages.length > 0
    ? detailImages
    : uniqueStrings(unknownImageValues(jsonLd?.image).flatMap((value) => normalizeImage(value, sourceUrl)));
  const stock = cleanText(detailRoot.querySelector('p.stock, .stock')?.text);
  const availability = resolveItalurAvailability(detailRoot, offer?.availability);
  const category = categoryFromClasses(detailRoot) ?? categoryFromBreadcrumb(root);
  const compatibility = inferItalurCompatibility([productName, description, category, cleanText(root.querySelector('.summary')?.text)].filter(Boolean).join(' '));

  return {
    productName,
    price: normalizeItalurPrice(rawPrice),
    currency: 'UYU',
    sku,
    description,
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    sourceUrl,
    availability,
    stock,
    category,
    ...compatibility,
    attributes: compactAttributes({
      codigo: sku,
    }),
    extractedAt: new Date().toISOString(),
    provider,
  };
}

export function dedupeItalurProducts(products: ProductRecord[]): { products: ProductRecord[]; duplicates: number } {
  const byKey = new Map<string, ProductRecord>();
  const urlBySku = new Map<string, string>();
  let duplicates = 0;
  for (const product of products) {
    const canonicalUrl = product.sourceUrl ? canonicalizeItalurUrl(product.sourceUrl) : undefined;
    const skuKey = cleanText(product.sku)?.toLowerCase();
    const existingUrl = skuKey ? urlBySku.get(skuKey) : undefined;
    const key = existingUrl ?? canonicalUrl;
    if (!key) continue;
    const previous = byKey.get(key);
    if (previous) duplicates += 1;
    byKey.set(key, previous ? mergeProduct(previous, { ...product, sourceUrl: key }) : { ...product, sourceUrl: key });
    if (skuKey) urlBySku.set(skuKey, key);
  }
  return { products: Array.from(byKey.values()), duplicates };
}

function resolveItalurAvailability(root: HTMLElement, explicit?: unknown): 'in_stock' | 'out_of_stock' | undefined {
  const explicitText = asText(explicit);
  if (/OutOfStock/i.test(explicitText ?? '')) return 'out_of_stock';
  if (/InStock/i.test(explicitText ?? '')) return 'in_stock';
  const classes = cleanText(root.getAttribute('class')) ?? '';
  const text = normalizeComparableText(`${root.text} ${classes}`);
  const hasBuyButton = root.querySelector('.single_add_to_cart_button, .add_to_cart_button, button[name="add-to-cart"]');
  if (classes.includes('outofstock') || /agotado/.test(text) || (/leer mas/.test(text) && !hasBuyButton)) return 'out_of_stock';
  if (classes.includes('instock') || hasBuyButton || /anadir al carrito|añadir al carrito|\d+\s+disponibles?/.test(text)) return 'in_stock';
  return undefined;
}

function inferItalurCompatibility(value: string): Pick<ProductRecord, 'compatibleBrands' | 'compatibleModels'> {
  const normalized = normalizeComparableText(value);
  const compatibleBrands = VEHICLE_BRANDS.filter((brand) => normalized.includes(normalizeComparableText(brand)));
  if (!compatibleBrands.includes('Chevrolet') && /\bch\b/.test(normalized)) compatibleBrands.push('Chevrolet');
  const compatibleModels = VEHICLE_MODELS.filter((model) => normalized.includes(normalizeComparableText(model)))
    .map((model) => model === 'Dmax' ? 'D-Max' : model);
  return {
    compatibleBrands: uniqueStrings(compatibleBrands),
    compatibleModels: uniqueStrings(compatibleModels),
  };
}

function extractImages(root: HTMLElement, pageUrl: string): string[] {
  const images: string[] = [];
  for (const element of root.querySelectorAll('.woocommerce-product-gallery a[href], .woocommerce-product-gallery img, .wpex-loop-product-images img, img.wp-post-image, meta[property="og:image"]')) {
    const preferred = [
      element.getAttribute('data-large_image'),
      element.getAttribute('data-src'),
      element.getAttribute('href'),
      element.getAttribute('content'),
    ].filter((value): value is string => Boolean(value));
    const values = preferred.length > 0 ? preferred : [element.getAttribute('src')].filter((value): value is string => Boolean(value));
    images.push(...values.flatMap((value) => normalizeImage(value, pageUrl)));
  }
  return uniqueStrings(images);
}

function extractDetailImages(root: HTMLElement, pageUrl: string): string[] {
  const images: string[] = [];
  for (const element of root.querySelectorAll('.woocommerce-product-gallery a[href], .woocommerce-product-gallery img')) {
    const preferred = [
      element.getAttribute('data-large_image'),
      element.getAttribute('data-src'),
      element.getAttribute('href'),
      element.getAttribute('content'),
    ].filter((value): value is string => Boolean(value));
    const values = preferred.length > 0 ? preferred : [element.getAttribute('src')].filter((value): value is string => Boolean(value));
    images.push(...values.flatMap((value) => normalizeImage(value, pageUrl)));
  }
  return uniqueStrings(images);
}

function normalizeImage(value: string | undefined, pageUrl: string): string[] {
  const cleaned = cleanText(value);
  if (!cleaned) return [];
  const normalized = normalizeUrl(cleaned, pageUrl);
  if (!normalized || !IMAGE_PATTERN.test(normalized) || NON_PRODUCT_IMAGE_PATTERN.test(normalized)) return [];
  return [normalized];
}

function extractJsonLdProduct(root: HTMLElement): JsonLdProduct | undefined {
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.text);
      const nodes = flattenJsonLd(parsed);
      const product = nodes.find((node) => String(node['@type'] ?? '').toLowerCase() === 'product');
      if (product) return product as JsonLdProduct;
    } catch {
      // Ignore malformed structured data.
    }
  }
  return undefined;
}

function flattenJsonLd(value: unknown): JsonRecord[] {
  const stack = Array.isArray(value) ? [...value] : [value];
  const result: JsonRecord[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = current as JsonRecord;
    result.push(record);
    Object.values(record).filter((item) => item && typeof item === 'object').forEach((item) => stack.push(item));
  }
  return result;
}

function categoryFromClasses(root: HTMLElement): string | undefined {
  const classes = String(root.getAttribute('class') ?? '').split(/\s+/);
  const slug = classes.find((entry) => entry.startsWith('product_cat-'))?.replace(/^product_cat-/, '');
  return slug ? titleFromSlug(slug) : undefined;
}

function categoryFromBreadcrumb(root: HTMLElement): string | undefined {
  return root.querySelectorAll('.woocommerce-breadcrumb a, nav.breadcrumb a')
    .map((anchor) => cleanText(anchor.text))
    .filter((value): value is string => Boolean(value))
    .filter((value) => !/^inicio|productos$/i.test(value))
    .at(-1);
}

function cleanDescription(value: string | undefined): string | undefined {
  const text = cleanText(value);
  if (!text || text.length > 1200 || /todos los derechos reservados|carrito|productos relacionados/i.test(text)) return undefined;
  return text;
}

function codeFromDescription(value: string | undefined): string | undefined {
  const match = value?.match(/\b[A-Z]?-?\d[A-Z0-9.-]{3,}\b/i);
  return match?.[0]?.toUpperCase();
}

function cleanSku(value: string | undefined): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  return cleanText(text.replace(/^(?:sku|c[oó]d(?:igo)?)\s*[:#-]?\s*/i, ''));
}

function pageNumberFromUrl(value: string): number | undefined {
  try {
    const match = new URL(value).pathname.match(/\/page\/(\d+)\/?$/i);
    return match ? Number(match[1]) : 1;
  } catch {
    return undefined;
  }
}

function normalizeUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value || value.startsWith('#') || /^(?:javascript|mailto|tel):/i.test(value)) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return /^https?:$/i.test(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function unknownImageValues(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(unknownImageValues);
  return [];
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? cleanText(String(value)) : undefined;
}

function titleFromSlug(value: string): string {
  return value.split('-').filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => cleanText(value));
}

function firstElement(root: HTMLElement, selectors: string[]): HTMLElement | undefined {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function compactAttributes(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mergeProduct(previous: ProductRecord, product: ProductRecord): ProductRecord {
  return {
    ...previous,
    ...product,
    productName: product.productName ?? previous.productName,
    price: product.price ?? previous.price,
    currency: product.currency ?? previous.currency,
    sku: product.sku ?? previous.sku,
    description: product.description ?? previous.description,
    category: product.category ?? previous.category,
    availability: product.availability ?? previous.availability,
    stock: product.stock ?? previous.stock,
    imageUrl: product.imageUrl ?? previous.imageUrl,
    imageUrls: uniqueStrings([...(previous.imageUrls ?? []), ...(product.imageUrls ?? [])]),
    compatibleBrands: uniqueStrings([...(previous.compatibleBrands ?? []), ...(product.compatibleBrands ?? [])]),
    compatibleModels: uniqueStrings([...(previous.compatibleModels ?? []), ...(product.compatibleModels ?? [])]),
  };
}
