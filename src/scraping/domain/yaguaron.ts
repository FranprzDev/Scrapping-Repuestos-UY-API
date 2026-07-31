import { HTMLElement, parse } from 'node-html-parser';
import { ProductRecord, ProviderName } from '../interfaces/scraping.types';
import { cleanText, normalizePriceValue } from './product-quality';

export const YAGUARON_PRODUCT_PATH = /\/catalogo\/[^/?#]+_\d+_\d+\/?$/i;

export interface YaguaronListingSummary {
  pageItems: number;
  declaredTotal?: number;
}

export function isYaguaronProductUrl(value: string): boolean {
  try {
    return YAGUARON_PRODUCT_PATH.test(new URL(value).pathname);
  } catch {
    return YAGUARON_PRODUCT_PATH.test(value);
  }
}

export function canonicalizeYaguaronProductUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!isYaguaronProductUrl(url.toString())) return undefined;
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return undefined;
  }
}

export function extractYaguaronListingSummary(html: string): YaguaronListingSummary {
  const root = parse(html);
  const list = root.querySelector('.aListProductos');
  const cards = root.querySelectorAll('.aListProductos > .it[data-codprod]');
  const declaredTotal = parseCount(list?.getAttribute('data-totabs'))
    ?? parseCount(list?.getAttribute('data-total'));
  return { pageItems: parseCount(list?.getAttribute('data-tot')) ?? cards.length, declaredTotal };
}

export function extractYaguaronProductUrls(html: string, pageUrl: string): string[] {
  const urls = parse(html).querySelectorAll('a[href]').flatMap((anchor) => {
    const normalized = normalizeUrl(anchor.getAttribute('href'), pageUrl);
    const canonical = normalized ? canonicalizeYaguaronProductUrl(normalized) : undefined;
    return canonical ? [canonical] : [];
  });
  return Array.from(new Set(urls));
}

export function extractYaguaronCategoryUrls(html: string, pageUrl: string): string[] {
  const root = parse(html);
  const origin = new URL(pageUrl).origin;
  const selectors = ['#menu a[href]', 'nav a[href]', '.menu a[href]', '[class*="menu"] a[href]'];
  const urls = selectors.flatMap((selector) => root.querySelectorAll(selector)).flatMap((anchor) => {
    const value = normalizeUrl(anchor.getAttribute('href'), pageUrl);
    if (!value || new URL(value).origin !== origin || isYaguaronProductUrl(value)) return [];
    const url = new URL(value);
    if (/\/(?:contacto|carrito|mi-cuenta|blog)(?:\/|$)/i.test(url.pathname)) return [];
    const segments = url.pathname.split('/').filter(Boolean);
    const hasCatalogFilter = ['marca', 'modelo', 'marca-comp', 'modelo-comp'].some((key) => url.searchParams.has(key));
    return segments.length > 0 && segments.length <= 3 || hasCatalogFilter ? [url.toString()] : [];
  });
  return Array.from(new Set(urls));
}

export function extractYaguaronDetail(html: string, pageUrl: string, provider: ProviderName): ProductRecord | undefined {
  const sourceUrl = canonicalizeYaguaronProductUrl(pageUrl);
  if (!sourceUrl) return undefined;
  const root = parse(html);
  const jsonLd = extractJsonLd(root);
  const labels = extractLabelValues(root);
  const productName = firstText(root, ['h1', '.aFichaProducto .tit', '.fichaProducto .tit', '[itemprop="name"]'])
    ?? asText(jsonLd?.name);
  if (!productName) return undefined;

  const rawPrice = firstText(root, ['.precio.venta', '.precio', '[itemprop="price"]', '.precios'])
    ?? asText(jsonLd?.offers?.price);
  const sku = label(labels, ['art', 'articulo', 'codigo'])
    ?? firstText(root, ['[data-codprod]', '[itemprop="sku"]'])?.replace(/^(?:art\.?|sku|c[oó]digo)\s*[:#-]?\s*/i, '')
    ?? asText(jsonLd?.sku);
  const characteristics = extractCharacteristics(root);
  const description = firstText(root, ['.descripcion', '[itemprop="description"]', '.blkDescripcion', '.detalleProducto .texto'])
    ?? asText(jsonLd?.description)
    ?? (characteristics.length > 0 ? characteristics.map(([key, value]) => `${key}: ${value}`).join('; ') : undefined);
  const imageUrls = extractProductImages(root, sourceUrl, jsonLd);
  const pageText = cleanText(root.querySelector('body')?.text ?? root.text) ?? '';
  const available = /comprar|agregar al carrito/i.test(pageText) && !/agotado|sin stock|no disponible/i.test(pageText);
  const unavailable = /agotado|sin stock|no disponible/i.test(pageText);
  const quality = label(labels, ['calidad']);
  const manufacturer = label(labels, ['fabricante']);
  const references = label(labels, ['referencias', 'referencia']);
  const stock = label(labels, ['stock', 'existencia', 'disponibilidad']);
  const category = breadcrumb(root).at(-1);
  const compatibility = extractCompatibility(characteristics, labels);

  return {
    productName,
    price: normalizePriceValue(rawPrice),
    currency: 'UYU',
    sku: cleanText(sku),
    description,
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    sourceUrl,
    availability: unavailable ? 'out_of_stock' : available ? 'in_stock' : undefined,
    stock,
    category,
    brand: manufacturer,
    compatibleModels: compatibility.length > 0 ? compatibility : undefined,
    attributes: compactAttributes({
      calidad: quality,
      fabricante: manufacturer,
      referencias: references,
      caracteristicas: characteristics.length > 0 ? characteristics.map(([key, value]) => `${key}: ${value}`).join('; ') : undefined,
    }),
    extractedAt: new Date().toISOString(),
    provider,
  };
}

export function extractYaguaronDeclaredTotal(html: string): number | undefined {
  return extractYaguaronListingSummary(html).declaredTotal;
}

export function extractYaguaronArticlePosition(html: string): { current: number; total: number } | undefined {
  const text = cleanText(parse(html).text);
  const match = text?.match(/art[ií]culo\s+(\d+)\s+de\s+(\d+)/i);
  return match ? { current: Number(match[1]), total: Number(match[2]) } : undefined;
}

export function dedupeYaguaronProducts(products: ProductRecord[]): { products: ProductRecord[]; duplicates: number } {
  const byUrl = new Map<string, ProductRecord>();
  const urlBySku = new Map<string, string>();
  let duplicates = 0;
  for (const product of products) {
    const canonicalUrl = product.sourceUrl ? canonicalizeYaguaronProductUrl(product.sourceUrl) : undefined;
    if (!canonicalUrl) continue;
    const skuKey = cleanText(product.sku)?.toLowerCase();
    const existingUrl = skuKey ? urlBySku.get(skuKey) : undefined;
    const key = existingUrl ?? canonicalUrl;
    const previous = byUrl.get(key);
    if (previous) duplicates += 1;
    byUrl.set(key, previous ? { ...previous, ...product, sourceUrl: key } : { ...product, sourceUrl: key });
    if (skuKey) urlBySku.set(skuKey, key);
  }
  return { products: Array.from(byUrl.values()), duplicates };
}

function extractLabelValues(root: HTMLElement): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of root.querySelectorAll('.blkCaracteristicas .it, .lstCaracteristicas .it, .caracteristicas .it, dl, tr')) {
    const key = cleanText(item.querySelector('.tit, dt, th, [class*="label"]')?.text);
    const value = cleanText(item.querySelector('.val, dd, td, [class*="value"]')?.text);
    if (key && value) result.set(normalizeLabel(key), value);
  }
  const text = cleanText(root.querySelector('body')?.text ?? root.text) ?? '';
  for (const match of text.matchAll(/(?:^|\s)(Art\.?|Calidad|Fabricante|Referencias?|Stock)\s*:?\s*([^\n|]+?)(?=\s+(?:Art\.?|Calidad|Fabricante|Referencias?|Stock)\s*:|$)/gim)) {
    const key = normalizeLabel(match[1]);
    if (!result.has(key)) result.set(key, cleanText(match[2]) ?? '');
  }
  return result;
}

function extractCharacteristics(root: HTMLElement): Array<[string, string]> {
  const values: Array<[string, string]> = [];
  for (const item of root.querySelectorAll('.blkCaracteristicas .it, .lstCaracteristicas .it, .caracteristicas .it')) {
    const key = cleanText(item.querySelector('.tit, [class*="label"]')?.text);
    const value = cleanText(item.querySelector('.val, [class*="value"]')?.text);
    if (key && value) values.push([key.replace(/\s*:\s*$/, ''), value]);
  }
  return values;
}

function extractProductImages(root: HTMLElement, pageUrl: string, jsonLd?: JsonLdProduct): string[] {
  const selectors = ['.aFichaProducto .imagenes img', '.fichaProducto .imagenes img', '.galeriaProducto img', '[itemprop="image"]', 'main .producto img'];
  const candidates = selectors.flatMap((selector) => root.querySelectorAll(selector)).flatMap((image) => [
    image.getAttribute('data-zoom-image'), image.getAttribute('data-src'), image.getAttribute('src'), image.getAttribute('content'),
  ]);
  if (typeof jsonLd?.image === 'string') candidates.push(jsonLd.image);
  if (Array.isArray(jsonLd?.image)) candidates.push(...jsonLd.image.filter((value): value is string => typeof value === 'string'));
  return Array.from(new Set(candidates.flatMap((value) => {
    const url = normalizeUrl(value, pageUrl);
    if (!url || /logo|banner|placeholder|sin[-_]?imagen|no[-_]?image/i.test(url)) return [];
    return [url];
  })));
}

type JsonLdProduct = { name?: unknown; sku?: unknown; description?: unknown; image?: unknown; offers?: { price?: unknown } };
function extractJsonLd(root: HTMLElement): JsonLdProduct | undefined {
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const value = JSON.parse(script.text) as JsonLdProduct | JsonLdProduct[] | { '@graph'?: JsonLdProduct[] };
      const nodes: JsonLdProduct[] = Array.isArray(value) ? value : '@graph' in value ? value['@graph'] ?? [] : [value as JsonLdProduct];
      const product = nodes.find((node) => String((node as Record<string, unknown>)['@type']).toLowerCase() === 'product');
      if (product) return product;
    } catch { /* Ignore malformed structured data and continue with Fenicio HTML. */ }
  }
  return undefined;
}

function breadcrumb(root: HTMLElement): string[] {
  return root.querySelectorAll('.breadcrumb a, .migas a, [class*="breadcrumb"] a')
    .map((item) => cleanText(item.text))
    .filter((value): value is string => typeof value === 'string' && !/^inicio$/i.test(value));
}
function extractCompatibility(characteristics: Array<[string, string]>, labels: Map<string, string>): string[] {
  const values = [...characteristics.filter(([key]) => /modelo|aplicaci[oó]n|compatib/i.test(key)).map(([, value]) => value), label(labels, ['modelos', 'modelo', 'aplicacion', 'compatibilidad'])].filter((value): value is string => Boolean(value));
  return Array.from(new Set(values.flatMap((value) => value.split(/[,;|/]+/).map((part) => cleanText(part)).filter((part): part is string => Boolean(part)))));
}
function firstText(root: HTMLElement, selectors: string[]): string | undefined { for (const selector of selectors) { const element = root.querySelector(selector); const value = cleanText(element?.getAttribute('content') ?? element?.getAttribute('data-codprod') ?? element?.text); if (value) return value; } return undefined; }
function label(values: Map<string, string>, keys: string[]): string | undefined { for (const key of keys) { const value = values.get(normalizeLabel(key)); if (value) return value; } return undefined; }
function normalizeLabel(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '').toLowerCase(); }
function parseCount(value?: string): number | undefined { const parsed = Number(value?.replace(/\D/g, '')); return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined; }
function normalizeUrl(value: string | undefined, baseUrl: string): string | undefined { if (!value) return undefined; try { const url = new URL(value, baseUrl); return /^https?:$/.test(url.protocol) ? url.toString() : undefined; } catch { return undefined; } }
function asText(value: unknown): string | undefined { return typeof value === 'string' || typeof value === 'number' ? cleanText(String(value)) : undefined; }
function compactAttributes(values: Record<string, string | undefined>): Record<string, string> | undefined { const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])); return entries.length > 0 ? Object.fromEntries(entries) : undefined; }
