import { ProductRecord } from '../interfaces/scraping.types';
import { DomainRule } from './domain-rules';

const DEFAULT_NEGATIVE_AVAILABILITY = ['agotado', 'sin stock', 'out of stock', 'no disponible'];
const DEFAULT_POSITIVE_AVAILABILITY = ['en stock', 'disponible', 'agregar al carrito', 'anadir al carrito', 'comprar'];
const INVALID_PRODUCT_NAMES = new Set([
  'productos',
  'inicio',
  'home',
  '404',
  'pagina no encontrada',
  'pagina no encontrada',
  'finalizar compra',
  'ver mas',
  'ver más',
  'comprar',
]);
const INVALID_PRODUCT_NAME_PATTERNS = [
  /^ordenar por$/i,
  /^total productos(?:\s+\d+)?$/i,
  /^mostrar(?:\s+\d+)?$/i,
  /^filtros?$/i,
  /^resultados?$/i,
  /^compartir$/i,
  /^whatsapp$/i,
  /^facebook$/i,
  /^instagram$/i,
  /^telegram$/i,
  /^buscar$/i,
  /^ver mas(?: productos)?$/i,
  /^categoria(?:s)?$/i,
];
const AUTOMOTIVE_SIGNAL_PATTERN =
  /\b(repuesto|repuestos|autopartes?|automotriz|automotor|veh[ii]culo?s?|auto?s?|coches?|camioneta?s?|moto?s?|carrocer[ii]a|paragolpe|parachoque|faro|farol|optica|luz|espejo|retrovisor|guardabarro|cap[oó]t|parrilla|moldura|emblema|insignia|manija|cerradura|parabrisas|cristal|vidrio|filtro|aceite|lubricaci[oó]n|bomba|inyector|radiador|motor|embrague|freno|disco|pastilla|amortiguador|suspensi[oó]n|buje|rodam|terminal|rotula|homocinet|cardan|correa|bujia|bobina|alternador|arranque|sensor|arn[eé]s|cable|llanta|neumatic|cubierta|escape|silenciador|catalizador|bateria|refrigeraci[oó]n|climatizaci[oó]n|accesorios?|broche|clip|grapa|tornillo|tuerca|abrazadera|soporte|carcasa|tapa|valvula|transmision|cambio|direccion|traccion)\b/i;
const AUTOMOTIVE_PATH_SIGNAL_PATTERN =
  /\b(autopartes?|automotriz|automotor|veh[ii]culo?s?|auto?s?|coches?|camioneta?s?|moto?s?|carrocer[ii]a|paragolpe|parachoque|faro|farol|optica|luz|espejo|retrovisor|guardabarro|cap[oó]t|parrilla|moldura|emblema|insignia|manija|cerradura|parabrisas|cristal|vidrio|filtro|aceite|lubricaci[oó]n|bomba|inyector|radiador|motor|embrague|freno|disco|pastilla|amortiguador|suspensi[oó]n|buje|rodam|terminal|rotula|homocinet|cardan|correa|bujia|bobina|alternador|arranque|sensor|arn[eé]s|cable|llanta|neumatic|cubierta|escape|silenciador|catalizador|bateria|refrigeraci[oó]n|climatizaci[oó]n|accesorios?|broche|clip|grapa|tornillo|tuerca|abrazadera|soporte|carcasa|tapa|valvula|transmision|cambio|direccion|traccion)\b/i;
const AUTOMOTIVE_BRAND_PATTERN =
  /\b(fiat|ford|toyota|nissan|volkswagen|vw|renault|peugeot|citroen|chevrolet|gmc|gm|hyundai|kia|mazda|mitsubishi|suzuki|bmw|mercedes|audi|volvo|chery|geely|byd|honda|subaru|isuzu|jeep|ram|dodge|chrysler|opel|seat|skoda|land rover|mini)\b/i;
const BLOCKED_URL_HOST_PATTERNS = [
  /(^|\.)wa\.me$/i,
  /(^|\.)whatsapp\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)messenger\.com$/i,
  /(^|\.)telegram\.me$/i,
  /(^|\.)t\.me$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
];
const BLOCKED_URL_PATH_PATTERNS = [
  /\/share/i,
  /\/sharer/i,
  /\/send/i,
  /\/intent/i,
  /\/login/i,
  /\/logout/i,
  /\/checkout/i,
  /\/carrito/i,
  /\/cart/i,
  /\/mi-cuenta/i,
  /\/contacto/i,
  /\/buscar(?:[/?#]|$)/i,
  /\/search(?:[/?#]|$)/i,
  /\/sitemap/i,
  /\/rss/i,
  /\/order/i,
  /\/sort/i,
];

export function cleanText(value?: string): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

export function normalizePriceValue(value?: string): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return undefined;
  }

  const match = cleaned.match(/(?:US\$|\$U|\$|UYU|USD)?\s*([\d]{1,3}(?:[.,][\d]{3})+(?:[.,][\d]{1,2})?|[\d]+(?:[.,][\d]{1,2})?)/i);
  if (!match) {
    return undefined;
  }

  return match[1];
}

export function inferCurrency(value?: string, explicit?: string): string | undefined {
  if (explicit) {
    return explicit.toUpperCase();
  }

  if (!value) {
    return undefined;
  }

  if (/US\$|USD/i.test(value)) {
    return 'USD';
  }

  if (/\$U|UYU|\$/i.test(value)) {
    return 'UYU';
  }

  return undefined;
}

export function resolveAvailability(text: string, rule?: DomainRule): 'in_stock' | 'out_of_stock' | 'unknown' {
  const normalized = normalizeComparableText(text);
  const negatives = [...DEFAULT_NEGATIVE_AVAILABILITY, ...(rule?.negativeAvailabilityTexts ?? [])];
  const positives = [...DEFAULT_POSITIVE_AVAILABILITY, ...(rule?.positiveAvailabilityTexts ?? [])];

  if (negatives.some((entry) => normalized.includes(normalizeComparableText(entry)))) {
    return 'out_of_stock';
  }

  if (positives.some((entry) => normalized.includes(normalizeComparableText(entry)))) {
    return 'in_stock';
  }

  return 'unknown';
}

export function isSellableProduct(product: ProductRecord, rule?: DomainRule): boolean {
  if (!product.productName || !product.price || !product.sourceUrl) {
    return false;
  }

  const price = normalizePriceValue(product.price);
  if (!price) {
    return false;
  }

  const numericPrice = parseNormalizedPrice(price);
  if (numericPrice === undefined || numericPrice <= 0) {
    return false;
  }

  if (product.stock) {
    const stockValue = Number(product.stock.replace(',', '.'));
    if (!Number.isNaN(stockValue)) {
      return stockValue > 0;
    }
  }

  const availability = (product.availability ?? '').toLowerCase();
  if (availability.includes('out_of_stock')) {
    return false;
  }

  if (availability.includes('in_stock')) {
    return true;
  }

  return resolveAvailability([product.availability, product.description, product.productName].filter(Boolean).join(' '), rule) === 'in_stock';
}

export function qualityWarnings(product: ProductRecord, rule?: DomainRule): string[] {
  const warnings: string[] = [];
  const normalizedPrice = normalizePriceValue(product.price);

  if (!cleanText(product.productName)) {
    warnings.push('missing_name');
  }

  if (!normalizedPrice) {
    warnings.push('missing_price');
  }

  const name = cleanText(product.productName);
  const comparableName = name ? normalizeComparableText(name) : undefined;
  if (name && (INVALID_PRODUCT_NAMES.has(name.toLowerCase()) || INVALID_PRODUCT_NAME_PATTERNS.some((pattern) => pattern.test(name)))) {
    warnings.push('invalid_name');
  } else if (comparableName && INVALID_PRODUCT_NAMES.has(comparableName)) {
    warnings.push('invalid_name');
  }

  if (normalizedPrice) {
    const numericPrice = parseNormalizedPrice(normalizedPrice);
    if (numericPrice === undefined || numericPrice <= 0) {
      warnings.push('invalid_price');
    }
  }

  const sourceUrl = product.sourceUrl;
  if (!sourceUrl) {
    warnings.push('missing_url');
  } else if (isExternalProductUrl(sourceUrl, rule) || isBlockedUtilityUrl(sourceUrl)) {
    warnings.push('external_url');
  } else if (rule && rule.productUrlPatterns.length > 0 && !looksLikeProductUrl(sourceUrl, rule)) {
    warnings.push('invalid_product_url');
  }

  if (!isAutomotiveProduct(product, rule)) {
    warnings.push('non_automotive');
  }

  if ((product.description?.length ?? 0) > 1200) {
    warnings.push('noisy_description');
  }

  if (!isSellableProduct(product, rule)) {
    warnings.push('not_sellable');
  }

  return warnings;
}

export function qualityGate(products: ProductRecord[], rule?: DomainRule): ProductRecord[] {
  return dedupeProducts(
    products
      .map((product) => ({ ...product, qualityWarnings: qualityWarnings(product, rule) }))
      .filter((product) => {
        const warnings = product.qualityWarnings ?? [];
        return product.availability !== 'out_of_stock' && !warnings.some((warning) => HARD_REJECTION_WARNINGS.has(warning));
      }),
  );
}

export function countQualityWarnings(products: ProductRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const product of products) {
    for (const warning of product.qualityWarnings ?? []) {
      counts[warning] = (counts[warning] ?? 0) + 1;
    }
  }

  return counts;
}

export function dedupeProducts(products: ProductRecord[]): ProductRecord[] {
  const map = new Map<string, ProductRecord>();

  for (const product of products) {
    const key = buildDedupKey(product);

    if (!key) {
      continue;
    }

    const previous = map.get(key);
    if (!previous) {
      map.set(key, product);
      continue;
    }

    map.set(key, {
      ...previous,
      ...product,
      productName: product.productName ?? previous.productName,
      price: product.price ?? previous.price,
      currency: product.currency ?? previous.currency,
      brand: product.brand ?? previous.brand,
      category: product.category ?? previous.category,
      description: product.description ?? previous.description,
      availability: product.availability ?? previous.availability,
      stock: product.stock ?? previous.stock,
      sourceUrl: product.sourceUrl ?? previous.sourceUrl,
      imageUrl: product.imageUrl ?? previous.imageUrl,
      imagePath: product.imagePath ?? previous.imagePath,
      qualityWarnings: mergeWarnings(previous.qualityWarnings, product.qualityWarnings),
    });
  }

  return Array.from(map.values());
}

function buildDedupKey(product: ProductRecord): string | undefined {
  const sourceUrl = cleanText(product.sourceUrl)?.toLowerCase();
  if (sourceUrl) {
    return `url|${sourceUrl}`;
  }

  const productName = cleanText(product.productName)?.toLowerCase();
  if (!productName) {
    return undefined;
  }

  const brand = cleanText(product.brand)?.toLowerCase() ?? 'no-brand';
  return `name|${productName}|${brand}`;
}

function mergeWarnings(previous?: string[], current?: string[]): string[] | undefined {
  if (previous?.length && current?.length) {
    return Array.from(new Set([...previous, ...current]));
  }

  return current?.length ? current : previous;
}

const HARD_REJECTION_WARNINGS = new Set(['invalid_name', 'external_url', 'non_automotive', 'invalid_page']);

export function isAutomotiveProduct(product: ProductRecord, rule?: DomainRule): boolean {
  const sourceUrl = cleanText(product.sourceUrl);
  const evidenceParts = [
    product.productName,
    product.brand,
    product.category,
    product.description,
    product.compatibleVehicles?.join(' '),
    product.compatibleBrands?.join(' '),
    product.shippingInfo?.join(' '),
    Object.values(product.attributes ?? {}).join(' '),
  ].filter(Boolean);

  const evidence = normalizeComparableText(evidenceParts.join(' '));
  if (AUTOMOTIVE_SIGNAL_PATTERN.test(evidence) || AUTOMOTIVE_BRAND_PATTERN.test(evidence)) {
    return true;
  }

  const pathEvidence = sourceUrl ? normalizeComparableText(safePathFromUrl(sourceUrl) ?? '') : undefined;
  if (pathEvidence && (AUTOMOTIVE_PATH_SIGNAL_PATTERN.test(pathEvidence) || AUTOMOTIVE_BRAND_PATTERN.test(pathEvidence))) {
    return true;
  }

  if (sourceUrl && rule?.id !== 'feyvi' && looksLikeSpecificProductUrl(sourceUrl, rule)) {
    return true;
  }

  return false;
}

export function isBlockedUtilityUrl(candidateUrl: string): boolean {
  try {
    const url = new URL(candidateUrl);
    if (!/^https?:$/i.test(url.protocol)) {
      return true;
    }

    const hostname = url.hostname.toLowerCase();
    const pathname = `${url.pathname}${url.search}`.toLowerCase();

    if (BLOCKED_URL_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
      return true;
    }

    return BLOCKED_URL_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
  } catch {
    return true;
  }
}

export function isAllowedCatalogUrl(candidateUrl: string, baseUrl?: string): boolean {
  if (isBlockedUtilityUrl(candidateUrl)) {
    return false;
  }

  if (!baseUrl) {
    return true;
  }

  try {
    const candidate = new URL(candidateUrl);
    const base = new URL(baseUrl);
    return normalizeHostname(candidate.hostname) === normalizeHostname(base.hostname);
  } catch {
    return false;
  }
}

function isExternalProductUrl(candidateUrl: string, rule?: DomainRule): boolean {
  if (!rule?.hostnames?.length) {
    return false;
  }

  try {
    const hostname = normalizeHostname(new URL(candidateUrl).hostname);
    return !rule.hostnames.some((allowed) => normalizeHostname(allowed) === hostname);
  } catch {
    return true;
  }
}

function looksLikeProductUrl(sourceUrl: string, rule: DomainRule): boolean {
  if (rule.productUrlPatterns.some((pattern) => pattern.test(sourceUrl))) {
    return true;
  }

  const lowered = sourceUrl.toLowerCase();
  return /producto|productos|repuesto|repuestos|catalogo|product|shop|detalle|articulo|articulos/.test(lowered);
}

function looksLikeSpecificProductUrl(sourceUrl: string, rule?: DomainRule): boolean {
  if (rule?.productUrlPatterns.some((pattern) => pattern.test(sourceUrl))) {
    return true;
  }

  try {
    const url = new URL(sourceUrl);
    const pathname = url.pathname.toLowerCase();
    const segments = pathname.split('/').filter(Boolean);

    if (segments.length === 0) {
      return false;
    }

    if (/product|producto|productos|articulo|articulos|detalle|mostrar|item|sku/i.test(segments[0] ?? '')) {
      return segments.length >= 2;
    }

    if (/catalogo/i.test(segments[0] ?? '')) {
      return segments.length >= 3;
    }

    if (/repuestos?/i.test(segments[0] ?? '')) {
      return segments.length >= 3;
    }

    if (/product-category|categoria|category|shop|ofertas|outlet/i.test(segments[0] ?? '')) {
      return false;
    }

    if (url.searchParams.has('codigo') || url.searchParams.has('sku') || url.searchParams.has('id') || url.searchParams.has('producto')) {
      return true;
    }

    return segments.length >= 2 && /[-\d]/.test(segments[segments.length - 1] ?? '');
  } catch {
    return false;
  }
}

function safePathFromUrl(candidateUrl: string): string | undefined {
  try {
    return new URL(candidateUrl).pathname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function normalizeComparableText(value: string): string {
  return fixMojibake(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fixMojibake(value: string): string {
  return value
    .replace(/Ã¡/g, 'á')
    .replace(/Ã©/g, 'é')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã±/g, 'ñ')
    .replace(/Â/g, '');
}

function parseNormalizedPrice(value: string): number | undefined {
  const normalized = value.includes(',') && value.includes('.')
    ? value.replace(/\./g, '').replace(',', '.')
    : value.includes(',')
      ? value.replace(',', '.')
      : value;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '');
}
