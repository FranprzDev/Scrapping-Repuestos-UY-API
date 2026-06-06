import { HTMLElement, parse } from 'node-html-parser';
import { ProductRecord, ProviderName } from '../interfaces/scraping.types';
import { DomainRule } from './domain-rules';
import { cleanText, inferCurrency, normalizePriceValue, resolveAvailability } from './product-quality';

const GENERIC_PRICE_SELECTORS = ['.price', '[class*="price"]', '[class*="precio"]', '.woocommerce-Price-amount'];

export function extractCandidateLinks(html: string, baseUrl: string, rule: DomainRule): { productLinks: string[]; categoryLinks: string[] } {
  const root = parse(html);
  const productLinks = new Set<string>();
  const categoryLinks = new Set<string>();

  root.querySelectorAll('a[href]').forEach((anchor) => {
    const href = normalizeUrl(anchor.getAttribute('href'), baseUrl);
    if (!href || rule.excludeUrlPatterns.some((pattern) => pattern.test(href))) {
      return;
    }

    if (rule.productUrlPatterns.some((pattern) => pattern.test(href))) {
      productLinks.add(href);
      return;
    }

    const card = findCardContainer(anchor);
    const cardText = cleanText(card.text) ?? '';
    if (isSemanticProductLink(href, cardText, rule)) {
      productLinks.add(href);
      return;
    }

    if (rule.categoryUrlPatterns.some((pattern) => pattern.test(href))) {
      categoryLinks.add(href);
      return;
    }

    if (isSemanticCategoryLink(href, cardText)) {
      categoryLinks.add(href);
    }
  });

  return {
    productLinks: Array.from(productLinks),
    categoryLinks: Array.from(categoryLinks),
  };
}

export function extractProductsFromHtml(html: string, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord[] {
  const root = parse(html);
  const candidates: ProductRecord[] = [];
  const isDetailPage = isLikelyDetailPage(root, pageUrl, rule);

  candidates.push(...extractJsonLdProducts(root, pageUrl, provider));

  if (!isDetailPage) {
    candidates.push(...extractListProducts(root, pageUrl, provider, rule));
  }

  const detailProduct = extractDetailProduct(root, pageUrl, provider, rule);
  if (detailProduct) {
    candidates.push(detailProduct);
  }

  return candidates;
}

function extractJsonLdProducts(root: HTMLElement, pageUrl: string, provider: ProviderName): ProductRecord[] {
  const products: ProductRecord[] = [];

  root.querySelectorAll('script[type="application/ld+json"]').forEach((element) => {
    const raw = element.textContent;
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
        const productName = cleanText(asString(node.name));
        if (!productName) {
          continue;
        }

        const rawPrice = cleanText(asString(offer?.price) ?? asString(node.price));
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

function extractListProducts(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord[] {
  const products: ProductRecord[] = [];
  const seen = new Set<string>();

  root.querySelectorAll('a[href]').forEach((anchor) => {
    const href = normalizeUrl(anchor.getAttribute('href'), pageUrl);
    if (!href || seen.has(href)) {
      return;
    }

    const card = findCardContainer(anchor);
    const cardText = cleanText(card.text) ?? '';
    if (!isSemanticProductLink(href, cardText, rule)) {
      return;
    }

    seen.add(href);

    const productName = firstNonEmpty([
      cleanText(anchor.text),
      cleanText(firstElementText(card, ['h1', 'h2', 'h3', 'h4'])),
      cleanText(firstElementText(card, ['[class*="title"]', '[class*="name"]'])),
    ]);
    const rawPrice = extractPriceFromNode(card);
    if (!productName) {
      return;
    }

    products.push({
      productName,
      price: normalizePriceValue(rawPrice),
      currency: inferCurrency(rawPrice),
      sku: extractSku(cardText),
      description: cleanText(firstElementText(card, ['p'])),
      imageUrl: normalizeUrl(firstAttributeValue(card, ['img'], 'src') ?? firstAttributeValue(card, ['img'], 'data-src'), pageUrl),
      sourceUrl: href,
      availability:
        resolveAvailability(cardText, rule) === 'in_stock'
          ? 'in_stock'
          : resolveAvailability(cardText, rule) === 'out_of_stock'
            ? 'out_of_stock'
            : undefined,
      extractedAt: new Date().toISOString(),
      provider,
    });
  });

  return products;
}

function extractDetailProduct(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord | undefined {
  if (!isLikelyDetailPage(root, pageUrl, rule)) {
    return undefined;
  }

  const title = firstNonEmpty(selectText(root, rule.detailSelectors?.title ?? ['h1']));
  const rawPrice = firstNonEmpty(selectText(root, [...(rule.detailSelectors?.price ?? []), ...GENERIC_PRICE_SELECTORS]));
  if (!title) {
    return undefined;
  }

  const pageText = cleanText(firstElementText(root, ['body']) ?? root.text) ?? '';
  if (/(404|page not found|not found|pagina no encontrada|p[aá]gina no encontrada|no se ha podido encontrar)/i.test(pageText)) {
    return undefined;
  }
  const availabilityText = collectAvailabilityText(root);
  const availability = resolveDetailAvailability(root, availabilityText, rule);
  const brandText = firstNonEmpty(selectText(root, rule.detailSelectors?.brand ?? []));

  const skuText = firstNonEmpty(selectText(root, rule.detailSelectors?.sku ?? ['body']));

  return {
    productName: title,
    price: normalizePriceValue(rawPrice),
    currency: inferCurrency(rawPrice),
    brand: extractBrandFromText(brandText),
    sku: cleanText(skuText?.match(/(?:sku|c[oó]d\.?)[:#\s-]*([\w.-]+)/i)?.[1]),
    description: firstNonEmpty(selectText(root, rule.detailSelectors?.description ?? ['meta[name="description"]', 'main p'])),
    imageUrl:
      normalizeUrl(firstNonEmpty(attributeValues(root, rule.detailSelectors?.image ?? ['img'], 'src')), pageUrl)
      ?? normalizeUrl(firstAttributeValue(root, ['meta[property="og:image"]'], 'content'), pageUrl),
    sourceUrl: pageUrl,
    availability:
      availability === 'in_stock'
        ? 'in_stock'
        : availability === 'out_of_stock'
          ? 'out_of_stock'
          : resolveAvailability(pageText, rule) === 'in_stock'
            ? 'in_stock'
            : resolveAvailability(pageText, rule) === 'out_of_stock'
              ? 'out_of_stock'
              : undefined,
    extractedAt: new Date().toISOString(),
    provider,
  };
}

function selectText(root: HTMLElement, selectors: string[]): string[] {
  return selectors
    .flatMap((selector) =>
      queryAll(root, selector)
        .map((element) => cleanText(element.text) ?? cleanText(element.getAttribute('content'))),
    )
    .filter((value): value is string => Boolean(value));
}

function attributeValues(root: HTMLElement, selectors: string[], attribute: string): string[] {
  return selectors
    .flatMap((selector) =>
      queryAll(root, selector)
        .map((element) => cleanText(element.getAttribute(attribute))),
    )
    .filter((value): value is string => Boolean(value));
}

function extractPriceFromNode(node: HTMLElement): string | undefined {
  for (const selector of ['.price', '[class*="price"]', '[class*="precio"]', 'p', 'div']) {
    const text = cleanText(firstElementText(node, [selector]));
    if (normalizePriceValue(text)) {
      return text;
    }
  }

  const text = cleanText(node.text);
  return normalizePriceValue(text) ? text : undefined;
}

function findCardContainer(anchor: HTMLElement): HTMLElement {
  let current = anchor;

  for (let index = 0; index < 5; index += 1) {
    const parent = current.parentNode;
    if (!(parent instanceof HTMLElement)) {
      break;
    }

    const text = cleanText(parent.text) ?? '';
    if (normalizePriceValue(text) && text.length < 1500) {
      return parent;
    }

    current = parent;
  }

  return anchor.parentNode instanceof HTMLElement ? anchor.parentNode : anchor;
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

function extractBrandFromText(value: string | undefined): string | undefined {
  const text = cleanText(value);
  if (!text) {
    return undefined;
  }

  const candidate = text
    .split(/\s*[-|/]\s*/)
    .map((part) => cleanText(part))
    .find((part) => Boolean(part));

  if (!candidate || candidate.length > 40) {
    return undefined;
  }

  return candidate;
}
function collectAvailabilityText(root: HTMLElement): string {
  const sections = [
    '.opcionescarrito',
    '.opciones_cart',
    '.precios_cont',
    '.precio_cont_mas',
    '.prod_preciomas',
    'main',
  ];

  for (const selector of sections) {
    const section = root.querySelector(selector);
    if (!section) {
      continue;
    }

    const clone = parse(section.outerHTML);
    clone.querySelectorAll('[style*="display:none"], [hidden], script, style').forEach((element) => element.remove());
    const text = cleanText(clone.text);
    if (text) {
      return text;
    }
  }

  return cleanText(firstElementText(root, ['body']) ?? root.text) ?? '';
}

function resolveDetailAvailability(root: HTMLElement, availabilityText: string, rule: DomainRule): 'in_stock' | 'out_of_stock' | 'unknown' {
  const hiddenOutOfStock = root.querySelector('#producto_agotado');
  if (hiddenOutOfStock) {
    const style = String(hiddenOutOfStock.getAttribute('style') ?? '').toLowerCase();
    const hidden = style.includes('display:none');
    const agotadoText = cleanText(hiddenOutOfStock.text) ?? '';

    if (agotadoText && !hidden) {
      return 'out_of_stock';
    }
  }

  const buyCta = queryAll(root, 'button, a')
    .map((element) => cleanText(element.text) ?? '')
    .join(' ');

  const combinedText = [availabilityText, buyCta].filter(Boolean).join(' ');
  const resolved = resolveAvailability(combinedText, rule);
  if (resolved !== 'unknown') {
    return resolved;
  }

  return 'unknown';
}

function queryAll(root: HTMLElement, selector: string): HTMLElement[] {
  return selector
    .split(',')
    .flatMap((part) => root.querySelectorAll(part.trim()));
}

function firstElementText(root: HTMLElement, selectors: string[]): string | undefined {
  const element = selectors.flatMap((selector) => queryAll(root, selector))[0];
  return element?.text;
}

function firstAttributeValue(root: HTMLElement, selectors: string[], attribute: string): string | undefined {
  const element = selectors.flatMap((selector) => queryAll(root, selector))[0];
  return element?.getAttribute(attribute);
}

function isSemanticProductLink(href: string, cardText: string, rule: DomainRule): boolean {
  if (rule.productUrlPatterns.some((pattern) => pattern.test(href))) {
    return true;
  }

  const loweredHref = href.toLowerCase();
  const loweredText = normalizeComparableText(cardText);
  const hasNameSignal = /[a-z0-9]{3,}/i.test(loweredText);
  const hasProductSignal =
    /comprar|agregar al carrito|consultar|iva inc|en stock|agotado|sku|c[oó]d|precio|producto|repuesto|articulo|ficha/i.test(
      loweredText,
    );
  const excluded = /contacto|faq|mi-cuenta|carrito|login|checkout|terminos|privacidad/i.test(loweredHref);

  return !excluded && hasNameSignal && (hasProductSignal || /\/(?:producto|productos|repuesto|repuestos|catalogo|product|shop|articulo|articulos|detalle)\b/i.test(loweredHref));
}

function isSemanticCategoryLink(href: string, cardText: string): boolean {
  const loweredHref = href.toLowerCase();
  const loweredText = normalizeComparableText(cardText);
  const hasCategorySignal = /productos|catalogo|categoria|shop|ofertas|outlet|familia|marca|linea/i.test(
    `${loweredHref} ${loweredText}`,
  );
  const looksLikeProduct = Boolean(normalizePriceValue(cardText)) || /comprar|agregar al carrito|consultar|sku|c[oó]d/i.test(loweredText);

  return hasCategorySignal && !looksLikeProduct;
}

function isLikelyDetailPage(root: HTMLElement, pageUrl: string, rule: DomainRule): boolean {
  if (rule.productUrlPatterns.some((pattern) => pattern.test(pageUrl))) {
    return true;
  }

  const title = firstNonEmpty(selectText(root, rule.detailSelectors?.title ?? ['h1']));
  const price = firstNonEmpty(selectText(root, [...(rule.detailSelectors?.price ?? []), ...GENERIC_PRICE_SELECTORS]));
  if (!title) {
    return false;
  }

  const pageText = cleanText(firstElementText(root, ['body']) ?? root.text) ?? '';
  const availabilityText = collectAvailabilityText(root);
  const signals = `${pageText} ${availabilityText}`;
  return Boolean(price) || /comprar|agregar al carrito|consultar|en stock|agotado|sin stock|disponible|iva inc|producto|repuesto|articulo|ficha/i.test(
    normalizeComparableText(signals),
  );
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
