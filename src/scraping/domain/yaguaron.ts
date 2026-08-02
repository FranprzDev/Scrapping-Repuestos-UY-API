import { HTMLElement, parse } from 'node-html-parser';
import { ProductRecord, ProviderName } from '../interfaces/scraping.types';
import { cleanText, normalizePriceValue } from './product-quality';

export const YAGUARON_PRODUCT_PATH = /\/catalogo\/[^/?#]+_\d+_\d+\/?$/i;

const DESCRIPTION_NOISE_PATTERN = /env[ií]os?|medios? de pago|cambios?|devoluciones?|redes sociales|facebook|instagram|whatsapp|productos relacionados|inicio\s+cat[aá]logo/i;
const DESCRIPTION_REJECT_PATTERN = /({"?producto"?|precioMonto|tieneStock|productos relacionados|medios de pago|redes sociales)/i;
const REFERENCES_NOISE_PATTERN = /({"?producto"?|inicio|cat[aá]logo|env[ií]os?|medios de pago|redes sociales|productos relacionados|facebook|instagram|whatsapp)/i;
const REFERENCE_CODE_PATTERN = /\b[A-Z0-9][A-Z0-9.-]{4,}\b/g;
const REFERENCE_LABEL_PATTERN = /(?:referencias?|nro\.?\s*referencias?|n[uú]mero\s*referencias?)\s*:/i;
const NEXT_DESCRIPTION_LABEL_PATTERN = /\s+(?:art\.?|art[ií]culo|calidad|fabricante|modelo|modelos|aplicaci[oó]n|compatibilidad|stock|disponibilidad)\s*:/i;
const INFO_PATHS = new Set([
  '/nosotros',
  '/salir',
  '/tiendas',
  '/terminos-condiciones',
  '/trabaja-con-nosotros',
  '/como-comprar',
  '/condiciones-de-compra',
  '/envios-devoluciones',
  '/preguntas-frecuentes',
]);
const PRODUCT_IMAGE_SELECTORS = [
  '[data-zoom-image]',
  '[data-large-image]',
  '[data-full]',
  '[data-src]',
  '[data-original]',
  'img[src]',
  'source[srcset]',
  'a[href]',
];
const PRODUCT_IMAGE_CONTAINER_HINT = /(?:aFichaProducto|fichaProducto|producto(?:__)?(?:imagen|foto|galeria)|imagenes|galeria|thumb|zoom|swiper|slick|carousel|foto|image|pic)/i;
const RELATED_IMAGE_CONTAINER_HINT = /(?:relacionad|recomendad|similares|tambien|también|otros-productos|aListProductos|listProductos|productosRelacionados)/i;
const NON_PRODUCT_IMAGE_PATTERN = /(?:topbar|banner|ayala-ecommerce|logo|placeholder|sin[-_]?imagen|no[-_]?image|relacionad|footer|header|sprite|icon|favicon|loading|loader|blank|default|pixel|analytics|facebook|instagram|whatsapp)/i;
const IMAGE_URL_PATTERN = /\.(?:avif|webp|jpe?g|png|gif)(?:[?#]|$)|\/imagenes?\/|\/img\/|\/productos?\/|\/catalogo\//i;

export interface YaguaronListingSummary {
  pageItems: number;
  declaredTotal?: number;
}

type JsonRecord = Record<string, unknown>;
type JsonLdProduct = { name?: unknown; sku?: unknown; description?: unknown; image?: unknown; offers?: { price?: unknown } };
type EmbeddedYaguaronProduct = {
  producto?: JsonRecord;
  variantes?: unknown;
  variante?: unknown;
  variaciones?: unknown;
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
    const pathname = normalizePathname(url.pathname);
    if (INFO_PATHS.has(pathname) || /\/(?:contacto|carrito|mi-cuenta|blog)(?:\/|$)/i.test(pathname)) return [];
    const segments = pathname.split('/').filter(Boolean);
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
  const labels = extractLabelValues(detailRoot);
  const visibleSku = label(labels, ['art', 'articulo']);
  const fallbackSku = skuFromUrl(sourceUrl);
  const embedded = extractEmbeddedYaguaronProduct(root, visibleSku ?? fallbackSku);
  const characteristics = extractCharacteristics(detailRoot);
  const productName = firstText(detailRoot, ['h1', '.aFichaProducto .tit', '.fichaProducto .tit', '[itemprop="name"]'])
    ?? textValue(embedded?.producto, ['nombre'])
    ?? asText(jsonLd?.name);
  if (!productName) return undefined;

  const rawPrice = asText(embedded?.precioMonto)
    ?? firstText(detailRoot, ['.precio.venta', '.precio', '[itemprop="price"]', '.precios'])
    ?? asText(jsonLd?.offers?.price);
  const sku = visibleSku
    ?? textValue(embedded?.producto, ['codigo'])
    ?? fallbackSku;
  const quality = label(labels, ['calidad']) ?? embeddedCharacteristic(embedded?.carac, ['calidad']);
  const manufacturer = label(labels, ['fabricante'])
    ?? embeddedCharacteristic(embedded?.carac, ['fabricante'])
    ?? textValue(embedded?.producto, ['marca']);
  const description = cleanDescription(
    firstText(detailRoot, ['.descripcion', '[itemprop="description"]', '.blkDescripcion', '.detalleProducto .texto'])
      ?? asText(jsonLd?.description),
  );
  const references = cleanReferences(label(labels, ['referencias', 'referencia', 'nroreferencia', 'nroreferencias', 'numeroreferencia', 'numeroreferencias']))
    ?? cleanReferences(embeddedCharacteristic(embedded?.carac, ['referencias', 'referencia', 'nroreferencia', 'nroreferencias', 'numeroreferencia', 'numeroreferencias']))
    ?? extractReferencesFromDetail(detailRoot)
    ?? extractReferencesFromDescription(description);
  const imageUrls = extractProductImages(detailRoot, sourceUrl, sku, embedded, jsonLd);
  const pageText = cleanText(detailRoot.text) ?? '';
  const stockState = normalizeStock(embedded?.tieneStock);
  const available = stockState === 'in_stock' || (/comprar|agregar al carrito/i.test(pageText) && !/agotado|sin stock|no disponible/i.test(pageText));
  const unavailable = stockState === 'out_of_stock' || /agotado|sin stock|no disponible/i.test(pageText);
  const stock = label(labels, ['stock', 'existencia', 'disponibilidad']) ?? (stockState === 'in_stock' ? 'Disponible' : undefined);
  const category = breadcrumb(root).at(-1) ?? textValue(embedded?.producto, ['categoria']);
  const compatibility = extractCompatibility(characteristics, labels, embedded?.carac);
  const attributeCharacteristics = extractAttributeCharacteristics(characteristics, embedded?.carac);

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
      caracteristicas: attributeCharacteristics,
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
  for (const match of text.matchAll(/(?:^|\s)(Art\.?|Artículo|Calidad|Fabricante|Referencias?|Nro\.?\s*Referencias?|N[uú]mero\s*Referencias?|Stock|Disponibilidad)\s*:?\s*([^\n|]+?)(?=\s+(?:Art\.?|Artículo|Calidad|Fabricante|Referencias?|Nro\.?\s*Referencias?|N[uú]mero\s*Referencias?|Stock|Disponibilidad)\s*:|$)/gim)) {
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

function extractProductImages(root: HTMLElement, pageUrl: string, sku: string | undefined, embedded?: EmbeddedYaguaronProduct, jsonLd?: JsonLdProduct): string[] {
  const candidates = [
    ...extractEmbeddedProductImages(skuMatchesEmbeddedProduct(embedded, sku) ? embedded : undefined, sku),
    ...extractVisibleProductImages(root, pageUrl),
  ];
  if (jsonLdMatchesSku(jsonLd, sku)) {
    if (typeof jsonLd?.image === 'string') candidates.push(jsonLd.image);
    if (Array.isArray(jsonLd?.image)) candidates.push(...jsonLd.image.filter((value): value is string => typeof value === 'string'));
  }
  return uniqueStrings(candidates.flatMap((value) => normalizeProductImage(value, pageUrl)));
}

function extractEmbeddedProductImages(embedded?: EmbeddedYaguaronProduct, sku?: string): string[] {
  const variantImages = extractVariantImages(embedded, sku);
  const product = embedded?.producto;
  if (!product) return variantImages;
  const prioritized = ['img', 'imagen', 'image', 'urlImagen', 'urlimagen', 'foto', 'fotoPrincipal', 'imagenPrincipal'];
  const direct = prioritized.flatMap((key) => unknownImageValues(product[key], true));
  const nested = ['imagenes', 'images', 'fotos', 'galeria', 'galería'].flatMap((key) => unknownImageValues(product[key], true));
  return [...variantImages, ...direct, ...nested];
}

function extractVariantImages(embedded: EmbeddedYaguaronProduct | undefined, sku: string | undefined): string[] {
  const variants = [embedded?.variantes, embedded?.variante, embedded?.variaciones].flatMap(variantEntries);
  const matching = variants.filter((variant) => variantMatchesSku(variant, sku));
  const selected = matching.length > 0 ? matching : variants;
  return selected.flatMap((variant) => unknownImageValues(variant, true));
}

function variantEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(variantEntries);
  if (!isRecord(value)) return [];
  const direct = hasVariantSignal(value) ? [value] : [];
  const nested = Object.values(value).filter((child) => Array.isArray(child) || isRecord(child)).flatMap(variantEntries);
  return [...direct, ...nested];
}

function hasVariantSignal(value: JsonRecord): boolean {
  return Object.keys(value).some((key) => ['codigo', 'codigocompleto', 'sku', 'com', 'img', 'imagen', 'image', 'foto', 'galeria', 'imagenes', 'images'].includes(normalizeLabel(key)));
}

function variantMatchesSku(value: unknown, sku: string | undefined): boolean {
  const expected = cleanText(sku);
  if (!expected || !isRecord(value)) return Boolean(expected);
  const codes = ['codigo', 'codigocompleto', 'sku', 'com'].map((key) => textValue(value, [key])).filter((code): code is string => Boolean(code));
  return codes.some((code) => code === expected || code.startsWith(expected) || code.includes(expected));
}

function extractVisibleProductImages(root: HTMLElement, pageUrl: string): string[] {
  const candidates: string[] = [];
  for (const container of productImageContainers(root)) {
    if (isRelatedImageNode(container)) continue;
    for (const selector of PRODUCT_IMAGE_SELECTORS) {
      for (const element of container.querySelectorAll(selector)) {
        if (isRelatedImageNode(element) || !isLikelyProductImageNode(element)) continue;
        candidates.push(...imageAttributes(element, pageUrl));
      }
    }
  }
  return candidates;
}

function productImageContainers(root: HTMLElement): HTMLElement[] {
  const selectors = [
    '.imagenes',
    '.galeriaProducto',
    '.producto__imagenes',
    '.producto-imagenes',
    '.productoImagenes',
    '.fichaProducto .imagenes',
    '.aFichaProducto .imagenes',
    '.fichaProducto [class*="galeria"]',
    '.aFichaProducto [class*="galeria"]',
    '.fichaProducto [class*="gallery"]',
    '.aFichaProducto [class*="gallery"]',
    '.fichaProducto [class*="zoom"]',
    '.aFichaProducto [class*="zoom"]',
    '.fichaProducto [class*="swiper"]',
    '.aFichaProducto [class*="swiper"]',
    '.fichaProducto [class*="slick"]',
    '.aFichaProducto [class*="slick"]',
    '[data-gallery]',
    '[data-product-gallery]',
    '[class*="producto"][class*="imagen"]',
    '[class*="producto"][class*="galeria"]',
  ];
  const seen = new Set<HTMLElement>();
  const containers: HTMLElement[] = [];
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      if (!seen.has(element)) {
        seen.add(element);
        containers.push(element);
      }
    }
  }
  return containers;
}

function imageAttributes(element: HTMLElement, pageUrl: string): string[] {
  const values = [
    element.getAttribute('data-zoom-image'),
    element.getAttribute('data-large-image'),
    element.getAttribute('data-full'),
    element.getAttribute('data-src'),
    element.getAttribute('data-original'),
    element.getAttribute('src'),
    element.getAttribute('href'),
    firstSrcsetUrl(element.getAttribute('srcset')),
    firstSrcsetUrl(element.getAttribute('data-srcset')),
  ];
  return values.filter((value): value is string => Boolean(value)).filter((value) => isImageLikeValue(value, pageUrl));
}

function unknownImageValues(value: unknown, includeObjectValues = false): string[] {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap((child) => unknownImageValues(child, includeObjectValues));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => includeObjectValues || /img|imagen|image|foto|src|url/i.test(key) ? unknownImageValues(child, includeObjectValues) : []);
}

function normalizeProductImage(value: string, pageUrl: string): string[] {
  const imageValue = normalizeImageCandidateText(value);
  const url = normalizeUrl(imageValue, pageUrl);
  if (!url || !isImageLikeValue(url, pageUrl) || NON_PRODUCT_IMAGE_PATTERN.test(url)) return [];
  return [url];
}

function normalizeImageCandidateText(value: string): string | undefined {
  const text = cleanText(value)
    ?.replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/^url\((['"]?)(.*?)\1\)$/i, '$2')
    .replace(/^['"]|['"]$/g, '');
  if (!text) return undefined;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function isImageLikeValue(value: string, pageUrl: string): boolean {
  const imageValue = normalizeImageCandidateText(value);
  const normalized = normalizeUrl(imageValue, pageUrl);
  if (!normalized || NON_PRODUCT_IMAGE_PATTERN.test(normalized)) return false;
  return IMAGE_URL_PATTERN.test(normalized);
}

function skuMatchesEmbeddedProduct(embedded: EmbeddedYaguaronProduct | undefined, sku: string | undefined): boolean {
  const expected = cleanText(sku);
  const code = textValue(embedded?.producto, ['codigo']);
  return Boolean(embedded) && (!expected || !code || code === expected);
}

function jsonLdMatchesSku(jsonLd: JsonLdProduct | undefined, sku: string | undefined): boolean {
  const expected = cleanText(sku);
  const code = asText(jsonLd?.sku);
  return Boolean(jsonLd) && (!expected || !code || code === expected);
}

function isLikelyProductImageNode(element: HTMLElement): boolean {
  const attrs = [element.getAttribute('class'), element.getAttribute('id'), element.getAttribute('alt'), element.getAttribute('title')].filter(Boolean).join(' ');
  return !attrs || PRODUCT_IMAGE_CONTAINER_HINT.test(attrs) || element.tagName.toLowerCase() === 'img' || element.tagName.toLowerCase() === 'source';
}

function isRelatedImageNode(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentNode instanceof HTMLElement ? current.parentNode : null) {
    const attrs = [current.getAttribute('class'), current.getAttribute('id')].filter(Boolean).join(' ');
    if (RELATED_IMAGE_CONTAINER_HINT.test(attrs)) return true;
  }
  return false;
}

function firstSrcsetUrl(value: string | undefined): string | undefined {
  return value?.split(',').map((part) => cleanText(part)?.split(/\s+/)[0]).find((part): part is string => Boolean(part));
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

function extractEmbeddedYaguaronProduct(root: HTMLElement, expectedSku?: string): EmbeddedYaguaronProduct | undefined {
  const found: EmbeddedYaguaronProduct[] = [];
  for (const script of root.querySelectorAll('script')) {
    const text = script.text;
    if (!/("producto"\s*:|precioMonto|tieneStock)/.test(text)) continue;
    for (const candidate of jsonObjectCandidates(text)) {
      try {
        const product = findEmbeddedProduct(JSON.parse(candidate));
        if (product) found.push(product);
      } catch { /* Ignore non-JSON executable snippets. */ }
    }
  }
  const expected = cleanText(expectedSku);
  const matching = found.filter((product) => expected && textValue(product.producto, ['codigo']) === expected);
  return bestEmbeddedProduct(matching, expected) ?? bestEmbeddedProduct(found, expected);
}

function bestEmbeddedProduct(products: EmbeddedYaguaronProduct[], expectedSku: string | undefined): EmbeddedYaguaronProduct | undefined {
  return [...products].sort((left, right) => embeddedProductScore(right, expectedSku) - embeddedProductScore(left, expectedSku))[0];
}

function embeddedProductScore(product: EmbeddedYaguaronProduct, expectedSku: string | undefined): number {
  const variants = [product.variantes, product.variante, product.variaciones].flatMap(variantEntries);
  const matchingVariants = variants.filter((variant) => variantMatchesSku(variant, expectedSku));
  const selectedVariants = matchingVariants.length > 0 ? matchingVariants : variants;
  const variantImages = selectedVariants.flatMap((variant) => unknownImageValues(variant, true)).filter((value) => normalizeProductImage(value, 'https://www.yaguaron.com.uy/').length > 0);
  const productImages = extractEmbeddedProductImages({ producto: product.producto }, expectedSku).filter((value) => normalizeProductImage(value, 'https://www.yaguaron.com.uy/').length > 0);
  const usefulKeys = ['producto', 'variantes', 'variante', 'variaciones', 'precioMonto', 'moneda', 'carac', 'tieneStock']
    .filter((key) => (product as JsonRecord)[key] !== undefined).length;
  return (matchingVariants.length > 0 && variantImages.length > 0 ? 10_000 : 0)
    + (variantImages.length > 0 ? 5_000 : 0)
    + (productImages.length > 0 ? 1_000 : 0)
    + usefulKeys * 100
    + Object.keys(product).length
    + JSON.stringify(product).length / 10_000;
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
  if (isRecord(value.producto) && ('precioMonto' in value || 'moneda' in value || 'carac' in value || 'tieneStock' in value || 'variantes' in value || 'variante' in value || 'variaciones' in value)) {
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

function extractAttributeCharacteristics(characteristics: Array<[string, string]>, embeddedCarac: unknown): string | undefined {
  const values = characteristics.filter(([key]) => !isStructuredAttributeKey(key));
  const model = embeddedCharacteristic(embeddedCarac, ['modelo', 'modelos']);
  if (model && !values.some(([key]) => normalizeLabel(key) === 'modelo')) values.push(['Modelo', model]);
  return values.length > 0 ? values.map(([key, value]) => `${key}: ${value}`).join('; ') : undefined;
}

function isStructuredAttributeKey(value: string): boolean {
  return ['art', 'articulo', 'codigo', 'calidad', 'fabricante', 'referencia', 'referencias', 'nroreferencia', 'nroreferencias', 'numeroreferencia', 'numeroreferencias', 'stock', 'disponibilidad'].includes(normalizeLabel(value));
}

function embeddedCharacteristic(carac: unknown, keys: string[]): string | undefined {
  if (isRecord(carac)) return textValue(carac, keys);
  if (!Array.isArray(carac)) return undefined;
  const normalizedKeys = keys.map(normalizeLabel);
  for (const item of carac) {
    const match = embeddedCharacteristic(item, keys);
    if (match) return match;
    if (!isRecord(item)) continue;
    const key = textValue(item, ['nombre', 'titulo', 'label', 'key', 'caracteristica', 'carac', 'codigo']);
    if (!key || !normalizedKeys.includes(normalizeLabel(key))) continue;
    const value = textValue(item, ['valor', 'value', 'texto', 'descripcion', 'desc']);
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
  if (!text || text.length > 1200 || DESCRIPTION_REJECT_PATTERN.test(text)) return undefined;
  const kept = text
    .split(/(?:\n|\s{2,}| - )/)
    .map((part) => cleanText(part))
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .filter((part) => !DESCRIPTION_NOISE_PATTERN.test(part));
  return kept.length > 0 ? kept.join(' ') : undefined;
}

function cleanReferences(value: string | undefined): string | undefined {
  const text = cleanText(value);
  if (!text || text.length > 240 || REFERENCES_NOISE_PATTERN.test(text)) return undefined;
  const codes = text.match(REFERENCE_CODE_PATTERN);
  return codes && codes.length > 0 ? Array.from(new Set(codes)).join(' / ') : text;
}

function extractReferencesFromDetail(root: HTMLElement): string | undefined {
  for (const element of root.querySelectorAll('*')) {
    const text = cleanText(element.text);
    if (!text || !REFERENCE_LABEL_PATTERN.test(text)) continue;
    const references = extractReferencesFromDescription(text);
    if (references) return references;
  }
  return undefined;
}

function extractReferencesFromDescription(value: string | undefined): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  const label = text.match(REFERENCE_LABEL_PATTERN);
  if (!label || label.index === undefined) return undefined;
  const afterLabel = text.slice(label.index + label[0].length);
  const nextLabel = afterLabel.search(NEXT_DESCRIPTION_LABEL_PATTERN);
  const candidate = nextLabel >= 0 ? afterLabel.slice(0, nextLabel) : afterLabel;
  return cleanReferences(candidate);
}

function normalizePathname(value: string): string {
  const pathname = value.replace(/\/+$/, '') || '/';
  return pathname.toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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
