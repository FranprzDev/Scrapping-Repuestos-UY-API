import { ProductRecord, ProviderName } from '../interfaces/scraping.types';

const PRICE_REGEX = /(\$|USD|UYU)?\s?([\d]{1,3}(?:[.,][\d]{3})*(?:[.,][\d]{2})?)/i;
const SKU_REGEX = /(sku|c[oó]digo|code)[:\s#-]*([\w-]{3,})/i;
const BRAND_REGEX = /(marca|brand)[:\s-]*([\w\s-]{2,})/i;

export function normalizeToProducts(input: unknown, provider: ProviderName, sourceUrl?: string): ProductRecord[] {
  const text = JSON.stringify(input ?? '');
  const priceMatch = text.match(PRICE_REGEX);
  const skuMatch = text.match(SKU_REGEX);
  const brandMatch = text.match(BRAND_REGEX);

  const candidate: ProductRecord = {
    sourceUrl,
    extractedAt: new Date().toISOString(),
    provider,
  };

  if (priceMatch) {
    candidate.currency = normalizeCurrency(priceMatch[1]);
    candidate.price = priceMatch[2];
  }

  if (skuMatch) {
    candidate.sku = skuMatch[2];
  }

  if (brandMatch) {
    candidate.brand = brandMatch[2].trim();
  }

  if (!candidate.price && !candidate.brand && !candidate.sku) {
    return [];
  }

  return [candidate];
}

function normalizeCurrency(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  const value = input.toUpperCase();
  if (value.includes('$')) {
    return 'UYU';
  }

  if (value.includes('USD')) {
    return 'USD';
  }

  if (value.includes('UYU')) {
    return 'UYU';
  }

  return undefined;
}
