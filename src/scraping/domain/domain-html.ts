import * as cheerio from 'cheerio';
import { ProductRecord, ProviderName } from '../interfaces/scraping.types';
import { DomainRule } from './domain-rules';
import { cleanText, inferCurrency, normalizePriceValue, resolveAvailability } from './product-quality';

const GENERIC_PRICE_SELECTORS = ['.price', '[class*="price"]', '[class*="precio"]', '.woocommerce-Price-amount'];

export function extractCandidateLinks(html: string, baseUrl: string, rule: DomainRule): { productLinks: string[]; categoryLinks: string[] } {
  const $ = cheerio.load(html);
  const productLinks = new Set<string>();
  const categoryLinks = new Set<string>();

  $('a[href]').each((_, anchor) => {
    const href = normalizeUrl($(anchor).attr('href'), baseUrl);
    if (!href || rule.excludeUrlPatterns.some((pattern) => pattern.test(href))) {
      return;
    }

    if (rule.productUrlPatterns.some((pattern) => pattern.test(href))) {
      productLinks.add(href);
      return;
    }

    if (rule.categoryUrlPatterns.some((pattern) => pattern.test(href))) {
      categoryLinks.add(href);
    }
  });

  return {
    productLinks: Array.from(productLinks),
    categoryLinks: Array.from(categoryLinks),
  };
}

export function extractProductsFromHtml(html: string, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord[] {
  const $ = cheerio.load(html);
  const candidates: ProductRecord[] = [];
  const isDetailPage = rule.productUrlPatterns.some((pattern) => pattern.test(pageUrl));

  candidates.push(...extractJsonLdProducts($, pageUrl, provider));

  if (!isDetailPage) {
    candidates.push(...extractListProducts($, pageUrl, provider, rule));
  }

  const detailProduct = extractDetailProduct($, pageUrl, provider, rule);
  if (detailProduct) {
    candidates.push(detailProduct);
  }

  return candidates;
}

function extractJsonLdProducts($: cheerio.CheerioAPI, pageUrl: string, provider: ProviderName): ProductRecord[] {
  const products: ProductRecord[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text();
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const node of flattenJsonLd(parsed)) {
        if ((node['@type'] ?? '') !== 'Product') {
          continue;
        }

        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        const rawPrice = cleanText(asString(offer?.price) ?? asString(node.price));
        const productName = cleanText(asString(node.name));
        if (!productName || !rawPrice) {
          continue;
        }

        const availabilityText = cleanText(asString(offer?.availability));
        products.push({
          productName,
          price: normalizePriceValue(rawPrice),
          currency: inferCurrency(rawPrice, cleanText(asString(offer?.priceCurrency))),
          sku: cleanText(asString(node.sku)),
          brand: cleanText(asString(node.brand?.name ?? node.brand)),
          description: cleanText(asString(node.description)),
          imageUrl: normalizeUrl(asString(Array.isArray(node.image) ? node.image[0] : node.image), pageUrl),
          sourceUrl: normalizeUrl(asString(node.url), pageUrl) ?? pageUrl,
          availability: availabilityText?.toLowerCase().includes('instock')
            ? 'in_stock'
            : availabilityText?.toLowerCase().includes('outofstock')
              ? 'out_of_stock'
              : undefined,
          extractedAt: new Date().toISOString(),
          provider,
        });
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  });

  return products;
}

function extractListProducts($: cheerio.CheerioAPI, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord[] {
  const products: ProductRecord[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_, anchor) => {
    const href = normalizeUrl($(anchor).attr('href'), pageUrl);
    if (!href || !rule.productUrlPatterns.some((pattern) => pattern.test(href)) || seen.has(href)) {
      return;
    }

    seen.add(href);
    const card = findCardContainer($(anchor));
    const cardText = cleanText(card.text()) ?? '';
    if (resolveAvailability(cardText, rule) === 'out_of_stock') {
      return;
    }

    const productName = firstNonEmpty([
      cleanText($(anchor).text()),
      cleanText(card.find('h1, h2, h3, h4').first().text()),
      cleanText(card.find('[class*="title"], [class*="name"]').first().text()),
    ]);
    const rawPrice = extractPriceFromNode(card);
    if (!productName || !rawPrice) {
      return;
    }

    products.push({
      productName,
      price: normalizePriceValue(rawPrice),
      currency: inferCurrency(rawPrice),
      sku: extractSku(cardText),
      description: cleanText(card.find('p').first().text()),
      imageUrl: normalizeUrl(card.find('img').first().attr('src') ?? card.find('img').first().attr('data-src'), pageUrl),
      sourceUrl: href,
      availability: resolveAvailability(cardText, rule) === 'in_stock' ? 'in_stock' : undefined,
      extractedAt: new Date().toISOString(),
      provider,
    });
  });

  return products;
}

function extractDetailProduct($: cheerio.CheerioAPI, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord | undefined {
  if (!rule.productUrlPatterns.some((pattern) => pattern.test(pageUrl))) {
    return undefined;
  }

  const title = firstNonEmpty(selectText($, rule.detailSelectors?.title ?? ['h1']));
  const rawPrice = firstNonEmpty(selectText($, [...(rule.detailSelectors?.price ?? []), ...GENERIC_PRICE_SELECTORS]));
  if (!title || !rawPrice) {
    return undefined;
  }

  const pageText = cleanText($('body').text()) ?? '';
  const availabilityText = collectAvailabilityText($);
  const availability = resolveDetailAvailability($, availabilityText, rule);

  if (availability === 'out_of_stock') {
    return undefined;
  }

  const skuText = firstNonEmpty(selectText($, rule.detailSelectors?.sku ?? ['body']));

  return {
    productName: title,
    price: normalizePriceValue(rawPrice),
    currency: inferCurrency(rawPrice),
    sku: cleanText(skuText?.match(/(?:sku|c[oó]d\.?)[:#\s-]*([\w.-]+)/i)?.[1]),
    description: firstNonEmpty(selectText($, rule.detailSelectors?.description ?? ['meta[name="description"]', 'main p'])),
    imageUrl:
      normalizeUrl(firstNonEmpty(attributeValues($, rule.detailSelectors?.image ?? ['img'], 'src')), pageUrl)
      ?? normalizeUrl($('meta[property="og:image"]').attr('content'), pageUrl),
    sourceUrl: pageUrl,
    availability: availability === 'in_stock' ? 'in_stock' : resolveAvailability(pageText, rule) === 'in_stock' ? 'in_stock' : undefined,
    extractedAt: new Date().toISOString(),
    provider,
  };
}

function selectText($: cheerio.CheerioAPI, selectors: string[]): string[] {
  return selectors
    .flatMap((selector) =>
      $(selector)
        .map((_, element) => cleanText($(element).text()) ?? cleanText($(element).attr('content')))
        .get(),
    )
    .filter((value): value is string => Boolean(value));
}

function attributeValues($: cheerio.CheerioAPI, selectors: string[], attribute: string): string[] {
  return selectors
    .flatMap((selector) =>
      $(selector)
        .map((_, element) => cleanText($(element).attr(attribute)))
        .get(),
    )
    .filter((value): value is string => Boolean(value));
}

function extractPriceFromNode(node: cheerio.Cheerio<any>): string | undefined {
  for (const selector of ['.price', '[class*="price"]', '[class*="precio"]', 'p', 'div']) {
    const text = cleanText(node.find(selector).first().text());
    if (normalizePriceValue(text)) {
      return text;
    }
  }

  const text = cleanText(node.text());
  return normalizePriceValue(text) ? text : undefined;
}

function findCardContainer(anchor: cheerio.Cheerio<any>): cheerio.Cheerio<any> {
  let current = anchor;

  for (let index = 0; index < 5; index += 1) {
    const parent = current.parent();
    if (!parent.length) {
      break;
    }

    const text = cleanText(parent.text()) ?? '';
    if (normalizePriceValue(text) && text.length < 1500) {
      return parent;
    }

    current = parent;
  }

  return anchor.parent();
}

function flattenJsonLd(input: unknown): Array<Record<string, any>> {
  const stack = Array.isArray(input) ? [...input] : [input];
  const nodes: Array<Record<string, any>> = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    const record = current as Record<string, any>;
    nodes.push(record);
    Object.values(record).forEach((value) => {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    });
  }

  return nodes;
}

function normalizeUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.startsWith('javascript:') || value.startsWith('#') || value.startsWith('mailto:') || value.startsWith('tel:')) {
    return undefined;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => cleanText(value));
}

function extractSku(text: string): string | undefined {
  return cleanText(text.match(/(?:sku|c[oó]d\.?)[:#\s-]*([\w.-]+)/i)?.[1]);
}

function collectAvailabilityText($: cheerio.CheerioAPI): string {
  const sections = [
    '.opcionescarrito',
    '.opciones_cart',
    '.precios_cont',
    '.precio_cont_mas',
    '.prod_preciomas',
    'main',
  ];

  for (const selector of sections) {
    const section = $(selector).first();
    if (!section.length) {
      continue;
    }

    const clone = section.clone();
    clone.find('[style*="display:none"], [hidden], script, style').remove();
    const text = cleanText(clone.text());
    if (text) {
      return text;
    }
  }

  return cleanText($('body').text()) ?? '';
}

function resolveDetailAvailability($: cheerio.CheerioAPI, availabilityText: string, rule: DomainRule): 'in_stock' | 'out_of_stock' | 'unknown' {
  const hiddenOutOfStock = $('#producto_agotado').first();
  if (hiddenOutOfStock.length) {
    const style = String(hiddenOutOfStock.attr('style') ?? '').toLowerCase();
    const hidden = style.includes('display:none');
    const agotadoText = cleanText(hiddenOutOfStock.text()) ?? '';

    if (agotadoText && !hidden) {
      return 'out_of_stock';
    }
  }

  const buyCta = $('button, a')
    .map((_, element) => cleanText($(element).text()) ?? '')
    .get()
    .join(' ');

  const combinedText = [availabilityText, buyCta].filter(Boolean).join(' ');
  const resolved = resolveAvailability(combinedText, rule);
  if (resolved !== 'unknown') {
    return resolved;
  }

  return 'unknown';
}
