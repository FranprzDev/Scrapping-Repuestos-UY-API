import { ProductRecord } from '../interfaces/scraping.types';
import { DomainRule } from './domain-rules';

const DEFAULT_NEGATIVE_AVAILABILITY = ['agotado', 'sin stock', 'out of stock', 'no disponible', 'consultar'];
const DEFAULT_POSITIVE_AVAILABILITY = ['en stock', 'disponible', 'agregar al carrito', 'anadir al carrito', 'comprar'];
const INVALID_PRODUCT_NAMES = ['productos', 'inicio', 'home', '404', 'pagina no encontrada'];

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
  if (name && INVALID_PRODUCT_NAMES.includes(name.toLowerCase())) {
    warnings.push('invalid_name');
  } else if (comparableName && INVALID_PRODUCT_NAMES.includes(comparableName)) {
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
  } else if (rule && rule.productUrlPatterns.length > 0 && !looksLikeProductUrl(sourceUrl, rule)) {
    warnings.push('invalid_product_url');
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
      .filter((product) => !(product.qualityWarnings?.includes('invalid_page') ?? false)),
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

function looksLikeProductUrl(sourceUrl: string, rule: DomainRule): boolean {
  if (rule.productUrlPatterns.some((pattern) => pattern.test(sourceUrl))) {
    return true;
  }

  const lowered = sourceUrl.toLowerCase();
  return /producto|productos|repuesto|repuestos|catalogo|product|shop|detalle|articulo|articulos/.test(lowered);
}

function normalizeComparableText(value: string): string {
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
