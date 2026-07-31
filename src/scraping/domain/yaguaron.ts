import { HTMLElement, parse } from 'node-html-parser';
import { ProductRecord, ProviderName } from '../interfaces/scraping.types';
import { cleanText, normalizePriceValue } from './product-quality';

export const YAGUARON_PRODUCT_PATH = /\/catalogo\/[^/?#]+_\d+_\d+\/?$/i;

export interface YaguaronListingSummary {
  pageItems: number;
  declaredTotal?: number;
}

type JsonRecord = Record<string, unknown>;
type JsonLdProduct = { name?: unknown; sku?: unknown; description?: unknown; image?: unknown; offers?: { price?: unknown } };
type EmbeddedYaguaronProduct = {
  producto?: JsonRecord;
  precioMonto?: unknown;
  moneda?: JsonRecord;
  carac?: unknown;
  tieneStock?: unknown;
};

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
  const detailRoot = findDetailRoot(root);
  const jsonLd = extractJsonLd(root);
  const embedded = extractEmbeddedYaguaronProduct(root);
  const labels = extractLabelValues(detailRoot);
  const characteristics = extractCharacteristics(detailRoot);
  const productName = firstText(detailRoot, ['h1', '.aFichaProducto .tit', '.fichaProducto .tit', '[itemprop="name"]'])
    ?? textValue(embedded?.producto, ['nombre'])
    ?? asText(jsonLd?.name);
  if (!productName) return undefined;

  const rawPrice = firstText(detailRoot, ['.precio.venta', '.precio', '[itemprop="price"]', '.precios'])
    ?? asText(embedded?.precioMonto)
    ?? asText(jsonLd?.offers?.price);
  const sku = label(labels, ['art', 'articulo'])
    ?? textValue(embedded?.producto, ['codigo'])
    ?? skuFromUrl(sourceUrl);
  const quality = label(labels, ['calidad']) ?? embeddedCharacteristic(embedded?.carac, ['calidad']);
  const manufacturer = label(labels, ['fabricante'])
    ?? embeddedCharacteristic(embedded?.carac, ['fabricante'])
    ?? textValue(embedded?.producto, ['marca']);
  const references = cleanReferences(
    label(labels, ['referencias', 'referencia']) ?? embeddedCharacteristic(embedded?.carac, ['referencias', 'referencia']),
  );
  const description = cleanDescription(
    firstText(detailRoot, ['.descripcion', '[itemprop="description"]', '.blkDescripcion', '.detalleProducto .texto'])
      ?? asText(jsonLd?.description),
  );
  const imageUrls = extractProductImages(detailRoot, sourceUrl, embedded, jsonLd);
  const pageText = cleanText(detailRoot.text) ?? '';
  const stockState = normalizeStock(embedded?.tieneStock);
  const available = stockState === 'in_stock' || (/comprar|agregar al carrito/i.test(pageText) && !/agotado|sin stock|no disponible/i.test(pageText));
  const unavailable = stockState === 'out_of_stock' || /agotado|sin stock|no disponible/i.test(pageText);
  const stock = label(labels, ['stock', 'existencia', 'disponibilidad']) ?? (stockState === 'in_stock' ? 'Disponible' : undefined);
  const category = breadcrumb(root).at(-1) ?? textValue(embedded?.producto, ['categoria']);
  const compatibility = extractCompatibility(characteristics, labels, embedded?.carac);

  return {
    productName,
    price: normalizePriceValue(rawPrice),
    currency: textValue(embedded?.moneda, ['cod']) ?? 'UYU',
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

function findDetailRoot(root: HTMLElement): HTMLElement {
  return root.querySelector('.aFichaProducto, .fichaProducto, main[itemtype*="Product"], main') ?? root;
}

function extractLabelValues(root: HTMLElement): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of root.querySelectorAll('.blkCaracteristicas .it, .lstCaracteristicas .it, .caracteristicas .it, dl, tr')) {
    const key = cleanText(item.querySelector('.tit, dt, th, [class*="label"]')?.text);
    const value = cleanText(item.querySelector('.val, dd, td, [class*="value"]')?.text);
    if (key && value) result.set(normalizeLabel(key), value);
  }
  const text = cleanText(root.text) ?? '';
  for (const match of text.matchAll(/(?:^|\s)(Art\.?|Artículo|Calidad|Fabricante|Referencias?|Stock|Disponibilidad)\s*:?\s*([^\n|]+?)(?=\s+(?:Art\.?|Artículo|Calidad|Fabricante|Referencias?|Stock|Disponibilidad)\s*:|$)/gim)) {
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

function extractProductImages(root: HTMLElement, pageUrl: string, embedded?: EmbeddedYaguaronProduct, jsonLd?: JsonLdProduct): string[] {
  const selectors = ['.imagenes img', '.galeriaProducto img', '[itemprop="image"]', 'main .producto img'];
  const candidates = selectors.flatMap((selector) => root.querySelectorAll(selector)).flatMap((image) => [
    image.getAttribute('data-zoom-image'), image.getAttribute('data-src'), image.getAttribute('src'), image.getAttribute('content'),
  ]);
  const embeddedImage = textValue(embedded?.producto, ['img', 'imagen', 'image']);
  if (embeddedImage) candidates.push(embeddedImage);
  if (typeof jsonLd?.image === 'string') candidates.push(jsonLd.image);
  if (Array.isArray(jsonLd?.image)) candidates.push(...jsonLd.image.filter((value): value is string => typeof value === 'string'));
  return Array.from(new Set(candidates.flatMap((value) => {
    const url = normalizeUrl(value, pageUrl);
    if (!url || /logo|banner|placeholder|sin[-_]?imagen|no[-_]?image|relacionad/i.test(url)) return [];
    return [url];
  })));
}

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

function extractEmbeddedYaguaronProduct(root: HTMLElement): EmbeddedYaguaronProduct | undefined {
  for (const script of root.querySelectorAll('script')) {
    const text = script.text;
    if (!/("producto"\s*:|precioMonto|tieneStock)/.test(text)) continue;
    for (const candidate of jsonObjectCandidates(text)) {
      try {
        const found = findEmbeddedProduct(JSON.parse(candidate));
        if (found) return found;
      } catch { /* Ignore non-JSON executable snippets. */ }
    }
  }
  return undefined;
}

function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let index = text.indexOf('{'); index >= 0; index = text.indexOf('{', index + 1)) {
    const candidate = balancedJsonObject(text, index);
    if (candidate && /"producto"\s*:/.test(candidate)) candidates.push(candidate);
  }
  return candidates.sort((left, right) => left.length - right.length);
}

function balancedJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function findEmbeddedProduct(value: unknown): EmbeddedYaguaronProduct | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEmbeddedProduct(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (isRecord(value.producto) && ('precioMonto' in value || 'moneda' in value || 'carac' in value || 'tieneStock' in value)) {
    return value as EmbeddedYaguaronProduct;
  }
  for (const child of Object.values(value)) {
    const found = findEmbeddedProduct(child);
    if (found) return found;
  }
  return undefined;
}

function breadcrumb(root: HTMLElement): string[] {
  return root.querySelectorAll('.breadcrumb a, .migas a, [class*="breadcrumb"] a')
    .map((item) => cleanText(item.text))
    .filter((value): value is string => typeof value === 'string' && !/^inicio$/i.test(value));
}

function extractCompatibility(characteristics: Array<[string, string]>, labels: Map<string, string>, embeddedCarac: unknown): string[] {
  const values = [
    ...characteristics.filter(([key]) => /modelo|aplicaci[oó]n|compatib/i.test(key)).map(([, value]) => value),
    label(labels, ['modelos', 'modelo', 'aplicacion', 'compatibilidad']),
    embeddedCharacteristic(embeddedCarac, ['modelo', 'modelos', 'aplicacion', 'compatibilidad']),
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(values.flatMap((value) => value.split(/[,;|]+/).map((part) => cleanText(part)).filter((part): part is string => Boolean(part)))));
}

function embeddedCharacteristic(carac: unknown, keys: string[]): string | undefined {
  if (isRecord(carac)) return textValue(carac, keys);
  if (!Array.isArray(carac)) return undefined;
  for (const item of carac) {
    if (!isRecord(item)) continue;
    const key = textValue(item, ['nombre', 'titulo', 'label', 'key', 'caracteristica']);
    if (!key || !keys.map(normalizeLabel).includes(normalizeLabel(key))) continue;
    const value = textValue(item, ['valor', 'value', 'texto', 'descripcion']);
    if (value) return value;
  }
  return undefined;
}

function textValue(record: JsonRecord | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  const normalizedKeys = keys.map(normalizeLabel);
  for (const [key, value] of Object.entries(record)) {
    if (!normalizedKeys.includes(normalizeLabel(key))) continue;
    const text = asText(value);
    if (text) return text;
  }
  return undefined;
}

function cleanDescription(value: string | undefined): string | undefined {
  const text = cleanText(value);
  if (!text || text.length > 1200 || /({"?producto"?|precioMonto|tieneStock|productos relacionados|medios de pago|redes sociales)/i.test(text)) return undefined;
  const kept = text.split(/(?:\n|\s{2,}| - )/).map((part) => cleanText(part)).filter((part): part is string => Boolean(part) && !/env[ií]os?|medios? de pago|cambios?|devoluciones?|redes sociales|facebook|instagram|whatsapp|productos relacionados|inicio\s+cat[aá]logo/i.test(part));
  return kept.length > 0 ? kept.join(' ') : undefined;
}

function cleanReferences(value: string | undefined): string | undefined {
  const text = cleanText(value);
  if (!text || text.length > 200 || /({"?producto"?|inicio|cat[aá]logo|env[ií]os?|medios de pago|redes sociales)/i.test(text)) return undefined;
  const codes = text.match(/\b[A-Z0-9][A-Z0-9.-]{4,}\b/g);
  return codes && codes.length > 0 ? Array.from(new Set(codes)).join(' / ') : text;
}

function skuFromUrl(value: string): string | undefined {
  const match = new URL(value).pathname.match(/_(\d+)(?:_\d+)?\/?$/);
  return match?.[1];
}

function normalizeStock(value: unknown): 'in_stock' | 'out_of_stock' | undefined {
  if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') return 'in_stock';
  if (value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false') return 'out_of_stock';
  return undefined;
}

function firstText(root: HTMLElement, selectors: string[]): string | undefined { for (const selector of selectors) { const element = root.querySelector(selector); const value = cleanText(element?.getAttribute('content') ?? element?.text); if (value) return value; } return undefined; }
function label(values: Map<string, string>, keys: string[]): string | undefined { for (const key of keys) { const value = values.get(normalizeLabel(key)); if (value) return value; } return undefined; }
function normalizeLabel(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '').toLowerCase(); }
function parseCount(value?: string): number | undefined { const parsed = Number(value?.replace(/\D/g, '')); return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined; }
function normalizeUrl(value: string | undefined, baseUrl: string): string | undefined { if (!value) return undefined; try { const url = new URL(value, baseUrl); return /^https?:$/.test(url.protocol) ? url.toString() : undefined; } catch { return undefined; } }
function asText(value: unknown): string | undefined { return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? cleanText(String(value)) : undefined; }
function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function compactAttributes(values: Record<string, string | undefined>): Record<string, string> | undefined { const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])); return entries.length > 0 ? Object.fromEntries(entries) : undefined; }
