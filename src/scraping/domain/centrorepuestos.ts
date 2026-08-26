import { parse } from 'node-html-parser';
import { ProductRecord, ProviderName } from '../interfaces/scraping.types';
import { cleanText, inferCurrency, normalizePriceValue } from './product-quality';

const ALLOWED_HOSTS = new Set([
  'centrorepuestos.com.uy',
  'www.centrorepuestos.com.uy',
]);

export function isCentroRepuestosUrl(value: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isCentroRepuestosProductUrl(value: string): boolean {
  try {
    const url = new URL(value);

    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
      return false;
    }

    return (
      url.searchParams.get('main_page') === 'product_info' &&
      /^\d+$/.test(url.searchParams.get('products_id') ?? '')
    );
  } catch {
    return false;
  }
}

export function isCentroRepuestosCategoryUrl(value: string): boolean {
  try {
    const url = new URL(value);

    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
      return false;
    }

    const cPath = url.searchParams.get('cPath');

    return (
      url.searchParams.get('main_page') === 'index' &&
      Boolean(cPath && /^\d+(?:_\d+)*$/.test(cPath))
    );
  } catch {
    return false;
  }
}

export function extractCentroRepuestosLinks(
  html: string,
  baseUrl: string,
): {
  productUrls: string[];
  categoryUrls: string[];
} {
  const root = parse(html);
  const products = new Set<string>();
  const categories = new Set<string>();

  for (const anchor of root.querySelectorAll('a[href]')) {
    const rawHref = anchor.getAttribute('href');

    if (!rawHref) {
      continue;
    }

    let url: string;

    try {
      url = new URL(rawHref.replace(/&amp;/gi, '&'), baseUrl).toString();
    } catch {
      continue;
    }

    if (!isCentroRepuestosUrl(url)) {
      continue;
    }

    if (isCentroRepuestosProductUrl(url)) {
      products.add(canonicalizeCentroRepuestosProductUrl(url));
      continue;
    }

    if (isCentroRepuestosCategoryUrl(url)) {
  const categoryUrl = new URL(url);
  categoryUrl.hash = '';
  categories.add(categoryUrl.toString());
}
  }

  return {
    productUrls: Array.from(products),
    categoryUrls: Array.from(categories),
  };
}

export function extractCentroRepuestosProduct(
  html: string,
  pageUrl: string,
  provider: ProviderName,
): ProductRecord | undefined {
  if (!isCentroRepuestosProductUrl(pageUrl)) {
    return undefined;
  }

  const root = parse(html);

  const productName = firstText(root, [
    '#productName',
    '.productinfo-rightwrapper h1',
    '.product_title h1',
    'h1#productName',
  ]);

  if (!productName) {
    return undefined;
  }

  const rawPrice = firstText(root, [
    '#productPrices .productSpecialPrice',
    '#productPrices .single_price',
    '#productPrices',
    '.productprice-amount .productSpecialPrice',
    '.productprice-amount .single_price',
    '.productinfo-rightwrapper .product_price',
  ]);

  const normalizedPrice = normalizePriceValue(rawPrice);

  const sku =
    extractLabeledValue(root.text, /c[oÃ³]digo\s*:\s*([A-Z0-9._/-]+)/i) ??
    extractSkuFromText(root.text);

  const brand =
    extractLabeledValue(root.text, /marca\s*:\s*(\[[^\]]+\]|[A-Z0-9 ._-]+)/i);

  const description = extractCentroDescription(root);

  const imageUrl = extractMainImage(html, pageUrl, sku);

  return {
    productName,
    price: normalizedPrice ?? undefined,
    currency: inferCurrency(rawPrice ?? '$') ?? 'UYU',
    sku,
    brand,
    description,
    imageUrl,
    sourceUrl: canonicalizeCentroRepuestosProductUrl(pageUrl),
    extractedAt: new Date().toISOString(),
    provider,
  };
}

export function canonicalizeCentroRepuestosProductUrl(value: string): string {
  const url = new URL(value);

  const productId = url.searchParams.get('products_id');

  const canonical = new URL('/index.php', url.origin);
  canonical.searchParams.set('main_page', 'product_info');

  if (productId) {
    canonical.searchParams.set('products_id', productId);
  }

  return canonical.toString();
}

function firstText(
  root: ReturnType<typeof parse>,
  selectors: string[],
): string | undefined {
  for (const selector of selectors) {
    const node = root.querySelector(selector);
    const value = cleanText(node?.text);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function extractMainImage(
  html: string,
  baseUrl: string,
  sku?: string,
): string | undefined {
  const candidates: string[] = [];

  if (sku) {
    const escapedSku = sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const directMatch = html.match(
      new RegExp(`href=["']([^"']*images/items/${escapedSku}\\.(?:jpg|jpeg|png|webp))["']`, 'i'),
    );

    if (directMatch?.[1]) {
      candidates.push(directMatch[1]);
    }

    const srcMatch = html.match(
      new RegExp(`src=["']([^"']*images/items/${escapedSku}\\.(?:jpg|jpeg|png|webp))["']`, 'i'),
    );

    if (srcMatch?.[1]) {
      candidates.push(srcMatch[1]);
    }
  }

  const popupImageMatch = html.match(
    /<img[^>]+src=["']([^"']*bmz_cache\/[^"']+)["'][^>]+alt=["'][^"']+["']/i,
  );

  if (popupImageMatch?.[1]) {
    candidates.push(popupImageMatch[1]);
  }

  const genericItemMatch = html.match(
    /(?:href|src)=["']([^"']*images\/items\/[^"']+\.(?:jpg|jpeg|png|webp))["']/i,
  );

  if (genericItemMatch?.[1]) {
    candidates.push(genericItemMatch[1]);
  }

  for (const candidate of candidates) {
    try {
      return new URL(candidate.replace(/&amp;/gi, '&'), baseUrl).toString();
    } catch {
      continue;
    }
  }

  return undefined;
}

function extractCentroDescription(
  root: ReturnType<typeof parse>,
): string | undefined {
  const descriptionNode = root.querySelector('#description');

  if (!descriptionNode) {
    return undefined;
  }

  const clone = parse(descriptionNode.innerHTML);

  // Eliminar productos relacionados/similares y elementos auxiliares.
  for (const selector of [
    'table',
    'script',
    'style',
    '.product_simil',
    '.productSimilar',
    '[class*="similar"]',
  ]) {
    for (const node of clone.querySelectorAll(selector)) {
      node.remove();
    }
  }

  let value = cleanText(clone.text);

  if (!value) {
    return undefined;
  }

  // Marca se guarda separadamente.
  value = value
    .replace(/\s+Productos similares.*$/i, '')
    .replace(/\s+También compraron.*$/i, '')
    .replace(/\s*Marca\s*:\s*\[[^\]]+\].*$/i, '')
    .trim();

  return value || undefined;
}

function extractLabeledValue(
  text: string,
  pattern: RegExp,
): string | undefined {
  const cleaned = cleanText(text);

  if (!cleaned) {
    return undefined;
  }

  const match = cleaned.match(pattern);

  return cleanText(match?.[1]);
}

function extractSkuFromText(text: string): string | undefined {
  const cleaned = cleanText(text);

  if (!cleaned) {
    return undefined;
  }

  const match = cleaned.match(
    /(?:c[oÃ³]digo|sku)\s*[:#-]?\s*([A-Z0-9._/-]{2,40})/i,
  );

  return cleanText(match?.[1]);
}

