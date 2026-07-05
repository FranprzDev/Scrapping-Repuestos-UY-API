import { parse } from 'node-html-parser';
import { ProductRecord, ProviderName } from '../interfaces/scraping.types';
import { cleanText, inferCurrency, mergeCompatibleBrands, normalizePriceValue } from './product-quality';

export interface CatalogBrandSeed {
  brandLabel: string;
  sourceUrl: string;
}

export interface FenicioPageSummary {
  pageItems: number;
  totalResults: number;
}

type ShopifyProduct = {
  title?: unknown;
  handle?: unknown;
  body_html?: unknown;
  product_type?: unknown;
  vendor?: unknown;
  images?: Array<{ src?: unknown }>;
  variants?: Array<{
    price?: unknown;
    sku?: unknown;
    available?: unknown;
  }>;
};

export function buildShopifyProductsUrl(baseUrl: string, page: number, limit = 250): string {
  const url = new URL('/products.json', baseUrl);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('page', String(page));
  return url.toString();
}

export function extractShopifyProducts(
  body: string,
  baseUrl: string,
  provider: ProviderName,
): { products: ProductRecord[]; received: number } {
  let rawProducts: ShopifyProduct[] = [];
  try {
    const parsed = JSON.parse(body) as { products?: unknown };
    rawProducts = Array.isArray(parsed.products) ? parsed.products as ShopifyProduct[] : [];
  } catch {
    return { products: [], received: 0 };
  }

  const products = rawProducts.flatMap((product) => {
    const productName = cleanText(typeof product.title === 'string' ? product.title : undefined);
    const handle = cleanText(typeof product.handle === 'string' ? product.handle : undefined);
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const selectedVariant = variants.find((variant) => variant.available === true) ?? variants[0];
    const rawPrice = cleanText(typeof selectedVariant?.price === 'string' || typeof selectedVariant?.price === 'number' ? String(selectedVariant.price) : undefined);
    const price = normalizePriceValue(rawPrice);

    if (!productName || !handle || !price) {
      return [];
    }

    return [{
      productName,
      price,
      currency: 'UYU',
      brand: cleanText(typeof product.vendor === 'string' ? product.vendor : undefined),
      sku: cleanText(typeof selectedVariant?.sku === 'string' ? selectedVariant.sku : undefined),
      category: cleanText(typeof product.product_type === 'string' ? product.product_type : undefined),
      description: cleanText(typeof product.body_html === 'string' ? stripHtml(product.body_html) : undefined),
      imageUrl: normalizeUrl(typeof product.images?.[0]?.src === 'string' ? product.images[0].src : undefined, baseUrl),
      sourceUrl: new URL(`/products/${handle}`, baseUrl).toString(),
      availability: selectedVariant?.available === false ? 'out_of_stock' : 'in_stock',
      extractedAt: new Date().toISOString(),
      provider,
    }];
  });

  return { products, received: rawProducts.length };
}

export function extractCymacoBrandSeeds(html: string, baseUrl: string): CatalogBrandSeed[] {
  return uniqueBrandSeeds(
    parse(html).querySelectorAll('a[href*="marca-comp="]').map((anchor) => ({
      brandLabel: cleanText(anchor.text),
      sourceUrl: normalizeUrl(anchor.getAttribute('href'), baseUrl),
    })),
  );
}

export function extractFamilcarBrandSeeds(html: string, baseUrl: string): CatalogBrandSeed[] {
  return uniqueBrandSeeds(
    parse(html).querySelectorAll('#menu li.hdr > a.tit[href]').map((anchor) => ({
      brandLabel: cleanText(anchor.text),
      sourceUrl: normalizeUrl(anchor.getAttribute('href'), baseUrl),
    })),
  );
}

export function extractFenicioPageSummary(html: string): FenicioPageSummary | undefined {
  const list = parse(html).querySelector('.aListProductos[data-tot][data-totabs]');
  const pageItems = Number(list?.getAttribute('data-tot'));
  const totalResults = Number(list?.getAttribute('data-totabs'));

  if (!Number.isFinite(pageItems) || !Number.isFinite(totalResults)) {
    return undefined;
  }

  return { pageItems, totalResults };
}

export function buildFenicioPageUrl(sourceUrl: string, page: number): string {
  const url = new URL(sourceUrl);
  url.searchParams.set('js', '1');
  url.searchParams.set('pag', String(page));
  return url.toString();
}

export function extractFenicioProducts(
  html: string,
  pageUrl: string,
  provider: ProviderName,
  contextBrand?: string,
): ProductRecord[] {
  const root = parse(html);

  return root.querySelectorAll('.aListProductos > .it[data-codprod]').flatMap((card) => {
    const anchor = card.querySelector('.info a.tit[href]') ?? card.querySelector('a.img[href]');
    const sourceUrl = normalizeUrl(anchor?.getAttribute('href'), pageUrl);
    const productName = cleanText(anchor?.getAttribute('title')) ?? cleanText(anchor?.text);
    const rawPrice = cleanText(card.querySelector('.precio.venta')?.text ?? card.querySelector('.precios')?.text);
    const price = normalizePriceValue(rawPrice);

    if (!sourceUrl || !productName || !price) {
      return [];
    }

    const sku = cleanText(card.getAttribute('data-codprod'));
    const image = card.querySelector('img');
    const commercialBrand = cleanText(card.querySelector('.marca')?.text ?? card.querySelector('.logoMarca img')?.getAttribute('alt'));
    const available = card.getAttribute('data-disp') !== '0';

    return [{
      productName,
      price,
      currency: inferCurrency(rawPrice) ?? 'UYU',
      brand: commercialBrand,
      sku,
      imageUrl: normalizeUrl(image?.getAttribute('src') ?? image?.getAttribute('data-src'), pageUrl),
      sourceUrl,
      availability: available ? 'in_stock' : 'out_of_stock',
      compatibleBrands: mergeCompatibleBrands(undefined, contextBrand ? [contextBrand] : undefined),
      extractedAt: new Date().toISOString(),
      provider,
    }];
  });
}

export function extractLarriqueTotalResults(html: string): number | undefined {
  const root = parse(html);
  const text = cleanText(root.querySelector('body')?.text ?? root.text);
  const match = text?.match(/([\d.,]+)\s+productos\b/i);
  return match ? Number(match[1].replace(/\D/g, '')) : undefined;
}

export function buildLarriqueBrandUrl(baseUrl: string, brandLabel: string, page = 1): string {
  const url = new URL(`/search-by/${page}`, baseUrl);
  url.searchParams.set('searchBy[aux1]', brandLabel);
  url.searchParams.set('ss', 'closed');
  return url.toString();
}

export function buildLarriqueFinalPageUrl(sourceUrl: string, totalResults: number, pageSize = 24): string {
  const url = new URL(sourceUrl);
  const page = Math.max(1, Math.ceil(totalResults / pageSize));
  url.pathname = url.pathname.replace(/\/search-by\/\d+\/?$/i, `/search-by/${page}`);
  return url.toString();
}

export function extractLarriqueContextBrand(sourceUrl: string): string | undefined {
  try {
    return cleanText(new URL(sourceUrl).searchParams.get('searchBy[aux1]') ?? undefined);
  } catch {
    return undefined;
  }
}

export function extractLarriqueProducts(
  html: string,
  pageUrl: string,
  provider: ProviderName,
  contextBrand?: string,
): ProductRecord[] {
  const root = parse(html);

  return root.querySelectorAll('a.productViewContainer[href^="/p/"]').flatMap((card) => {
    const sourceUrl = normalizeUrl(card.getAttribute('href'), pageUrl);
    const productName = cleanText(card.querySelector('.productViewName')?.text ?? card.querySelector('img[alt]')?.getAttribute('alt'));
    const rawPrice = cleanText(card.querySelector('.productViewPrice')?.text);
    const price = normalizePriceValue(rawPrice);

    if (!sourceUrl || !productName || !price) {
      return [];
    }

    const skuText = cleanText(card.querySelector('.productCode')?.text);
    const sku = cleanText(skuText?.replace(/^SKU\s*/i, ''));
    const image = card.querySelector('img');

    return [{
      productName,
      price,
      currency: inferCurrency(rawPrice) ?? 'UYU',
      sku,
      imageUrl: normalizeUrl(image?.getAttribute('src') ?? image?.getAttribute('data-src'), pageUrl),
      sourceUrl,
      availability: 'in_stock',
      compatibleBrands: mergeCompatibleBrands(undefined, contextBrand ? [contextBrand] : undefined),
      extractedAt: new Date().toISOString(),
      provider,
    }];
  });
}

export function parseLarriqueBrandResponse(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { status?: string; results?: Array<{ name?: unknown }> };
    if (parsed.status !== 'ok' || !Array.isArray(parsed.results)) {
      return [];
    }

    return Array.from(new Set(parsed.results.map((item) => cleanText(typeof item.name === 'string' ? item.name : undefined)).filter((value): value is string => Boolean(value))));
  } catch {
    return [];
  }
}

function uniqueBrandSeeds(seeds: Array<{ brandLabel?: string; sourceUrl?: string }>): CatalogBrandSeed[] {
  const unique = new Map<string, CatalogBrandSeed>();

  for (const seed of seeds) {
    if (!seed.brandLabel || !seed.sourceUrl) {
      continue;
    }
    unique.set(seed.sourceUrl, { brandLabel: seed.brandLabel, sourceUrl: seed.sourceUrl });
  }

  return Array.from(unique.values());
}

function normalizeUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value, baseUrl);
    return /^https?:$/i.test(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function stripHtml(value: string): string {
  return parse(value).text;
}
