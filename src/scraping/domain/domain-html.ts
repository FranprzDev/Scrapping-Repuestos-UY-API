import { HTMLElement, parse } from 'node-html-parser';
import { ProductRecord, ProviderName } from '../interfaces/scraping.types';
import { DomainRule } from './domain-rules';
import { cleanText, inferCurrency, isAllowedCatalogUrl, normalizePriceValue, resolveAvailability } from './product-quality';

const GENERIC_PRICE_SELECTORS = ['.price', '[class*="price"]', '[class*="precio"]', '.woocommerce-Price-amount'];

export function extractCandidateLinks(html: string, baseUrl: string, rule: DomainRule): { productLinks: string[]; categoryLinks: string[] } {
  const root = parse(html);
  const productLinks = new Set<string>();
  const categoryLinks = new Set<string>();

  root.querySelectorAll('option[value]').forEach((option) => {
    const value = normalizeUrl(option.getAttribute('value'), baseUrl);
    if (!value || rule.excludeUrlPatterns.some((pattern) => pattern.test(value)) || !isAllowedCatalogUrl(value, baseUrl)) {
      return;
    }

    if (rule.id === 'chaparei') {
      if (isChapareiProductLink(value)) {
        productLinks.add(value);
        return;
      }

      const brandId = cleanText(option.getAttribute('value'));
      if (brandId && /^\d+$/.test(brandId)) {
        try {
          categoryLinks.add(new URL(`/productos/?m=${brandId}`, baseUrl).toString());
        } catch {
          // Ignore malformed brand options.
        }
        return;
      }

      if (isChapareiCategoryLink(value) || isChapareiSemanticCategoryLink(value, cleanText(option.text) ?? '')) {
        categoryLinks.add(value);
      }
    }
  });

  root.querySelectorAll('a[href]').forEach((anchor) => {
    const href = normalizeUrl(anchor.getAttribute('href'), baseUrl);
    if (!href || rule.excludeUrlPatterns.some((pattern) => pattern.test(href)) || !isAllowedCatalogUrl(href, baseUrl)) {
      return;
    }

    if (rule.id === 'chaparei') {
      const card = findChapareiCardContainer(anchor);
      const cardText = cleanText(card.text) ?? '';

      if (isChapareiProductLink(href)) {
        productLinks.add(href);
        return;
      }

      if (isChapareiCategoryLink(href)) {
        categoryLinks.add(href);
        return;
      }

      if (isChapareiSemanticProductLink(href, cardText)) {
        productLinks.add(href);
        return;
      }

      if (isChapareiSemanticCategoryLink(href, cardText)) {
        categoryLinks.add(href);
        return;
      }
    }

    if (rule.id === 'selvir') {
      const card = findSelvirCardContainer(anchor);
      const cardText = cleanText(card.text) ?? '';
      const hostname = safeHostname(href);
      const pathname = safePathname(href) ?? '';

      if (!hostname || !hostname.endsWith('selvir.com.uy')) {
        return;
      }

      if (pathname === '/' || pathname === '' || pathname === '/productos/') {
        return;
      }

      if (isSelvirProductCard(href, card, cardText)) {
        productLinks.add(href);
        return;
      }

      if (rule.categoryUrlPatterns.some((pattern) => pattern.test(href)) || /\/page\/\d+\/?$/i.test(href)) {
        categoryLinks.add(href);
        return;
      }
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

  root.querySelectorAll('link[rel]').forEach((element) => {
    const rel = (element.getAttribute('rel') ?? '').toLowerCase();
    const href = normalizeUrl(element.getAttribute('href'), baseUrl);
    if (!href || rule.excludeUrlPatterns.some((pattern) => pattern.test(href)) || !isAllowedCatalogUrl(href, baseUrl)) {
      return;
    }

    if (rel === 'next' || rel === 'prev') {
      categoryLinks.add(href);
    }
  });

  return {
    productLinks: Array.from(productLinks),
    categoryLinks: Array.from(categoryLinks),
  };
}

function isChapareiProductLink(href: string): boolean {
  return /\/catalogo\/[^/?#]+\/.+\/?$/i.test(href);
}

function isChapareiCategoryLink(href: string): boolean {
  try {
    const url = new URL(href);
    const pathname = url.pathname.toLowerCase();
    const hasModel = url.searchParams.has('m');
    const hasCategory = url.searchParams.has('c');
    return (
      !isChapareiProductLink(href)
      && (
        pathname === '/productos/'
        || pathname === '/productos/productos.php'
        || /\/catalogo\/[^/?#]+\/?$/i.test(pathname)
      )
      && (hasModel || hasCategory)
    );
  } catch {
    return false;
  }
}

function isChapareiSemanticProductLink(href: string, cardText: string): boolean {
  if (isChapareiProductLink(href)) {
    return true;
  }

  if (!/\/catalogo\/[^/?#]+\/?$/i.test(href) && !/\/productos\/(?:productos\.php)?\?/i.test(href)) {
    return false;
  }

  const loweredText = normalizeComparableText(cardText);
  return Boolean(loweredText) && /comprar|en stock|agotado|precio|c[oó]d|iva inc|producto|repuesto|articulo|ficha/.test(loweredText);
}

function isChapareiSemanticCategoryLink(href: string, cardText: string): boolean {
  if (isChapareiProductLink(href)) {
    return false;
  }

  const loweredText = normalizeComparableText(cardText);
  const loweredHref = href.toLowerCase();
  return /\/productos\/|\/catalogo\//.test(loweredHref) && /carrocer[ií]a|espejos|l[aá]mparas|seguridad|enfriamiento|tren delantero|manijas|filtros|accesorios|paragolpes|ofertas|outlet/.test(loweredText);
}

export function extractProductsFromHtml(html: string, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord[] {
  const root = parse(html);
  const candidates: ProductRecord[] = [];

  candidates.push(...extractJsonLdProducts(root, pageUrl, provider));

  if (rule.id === 'chaparei') {
    const detailProduct = extractChapareiDetailProduct(root, pageUrl, provider, rule);
    if (detailProduct) {
      candidates.push(detailProduct);
    } else {
      const chapareiProducts = extractChapareiListProducts(root, pageUrl, provider, rule);
      if (chapareiProducts.length > 0) {
        candidates.push(...chapareiProducts);
      } else {
        candidates.push(...extractListProducts(root, pageUrl, provider, rule));
      }
    }
    return candidates;
  }

  if (rule.id === 'taxitor') {
    const detailProduct = extractDetailProduct(root, pageUrl, provider, rule);
    if (detailProduct) {
      candidates.push(detailProduct);
    } else {
      candidates.push(...extractTaxitorListProducts(root, pageUrl, provider, rule));
    }
    return candidates;
  }

  const isDetailPage = isLikelyDetailPage(root, pageUrl, rule);

  if (!isDetailPage) {
    candidates.push(...extractListProducts(root, pageUrl, provider, rule));
  }

  const detailProduct = rule.id === 'selvir'
    ? extractSelvirDetailProduct(root, pageUrl, provider, rule)
    : extractDetailProduct(root, pageUrl, provider, rule);
  if (detailProduct) {
    candidates.push(detailProduct);
  }

  return candidates;
}

export function extractChapareiBrandsFromHtml(html: string, baseUrl: string): Array<{ brandId: string; brandLabel: string; sourceUrl: string }> {
  const root = parse(html);
  const brands: Array<{ brandId: string; brandLabel: string; sourceUrl: string }> = [];

  root.querySelectorAll('select#id_marca option[value]').forEach((option) => {
    const brandId = cleanText(option.getAttribute('value'));
    const brandLabel = cleanText(option.text);

    if (!brandId || !brandLabel || brandLabel.toLowerCase() === 'marca...') {
      return;
    }

    if (!/^\d+$/.test(brandId)) {
      return;
    }

    brands.push({
      brandId,
      brandLabel,
      sourceUrl: new URL(`/productos/?m=${brandId}`, baseUrl).toString(),
    });
  });

  return brands;
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

        const visiblePrice = /selvir\.com\.uy\/product\//i.test(pageUrl)
          ? firstNonEmpty([
              cleanText(firstElementText(root, ['.product-info-price .price-number'])),
              cleanText(firstElementText(root, ['.product-info-price .woocommerce-Price-amount'])),
              cleanText(firstElementText(root, ['.product-info-price'])),
              cleanText(firstElementText(root, ['.summary .price-number'])),
              cleanText(firstElementText(root, ['[class*="price-number"]'])),
            ])
          : undefined;
        const rawPrice = cleanText(
          visiblePrice
          ?? asString(offer?.price)
          ?? asString(offer?.priceSpecification?.[0]?.price)
          ?? asString(offer?.priceSpecification?.price)
          ?? asString(node.price),
        );
        const availabilityText = cleanText(asString(offer?.availability));
        products.push({
          productName,
          price: normalizePriceValue(rawPrice),
          currency: inferCurrency(rawPrice, cleanText(asString(offer?.priceCurrency))),
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
    if (!href || seen.has(href) || !isAllowedCatalogUrl(href, pageUrl)) {
      return;
    }

    const card = rule.id === 'selvir' ? findSelvirCardContainer(anchor) : findCardContainer(anchor);
    const cardText = cleanText(card.text) ?? '';
    if (!isSemanticProductLink(href, cardText, rule)) {
      return;
    }

    if (rule.id === 'selvir' && !isSelvirProductCard(href, card, cardText)) {
      return;
    }

    seen.add(href);

    const productName = rule.id === 'selvir'
      ? extractSelvirListingNameV2(anchor, card, cardText)
      : firstNonEmpty([
          cleanText(anchor.text),
          cleanText(firstElementText(card, ['h1', 'h2', 'h3', 'h4'])),
          cleanText(firstElementText(card, ['[class*="title"]', '[class*="name"]'])),
        ]);
    const rawPrice = rule.id === 'selvir'
      ? extractSelvirListingPriceV2(card, cardText) ?? extractPriceFromNode(card)
      : extractPriceFromNode(card);
    if (!productName) {
      return;
    }

    if (rule.id === 'feyvi' && (!rawPrice || isFeyviUiLabel(productName, cardText, href))) {
      return;
    }

    products.push({
      productName,
      price: normalizePriceValue(rawPrice),
      currency: inferCurrency(rawPrice),
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

function extractTaxitorListProducts(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord[] {
  const products: ProductRecord[] = [];
  const cards = queryAll(root, '.single-product-wrapper');

  for (const card of cards) {
    const sourceUrl = firstNonEmpty([
      normalizeUrl(firstAttributeValue(card, ['a[href*="/articulos/mostrar/"]'], 'href'), pageUrl),
      normalizeUrl(firstAttributeValue(card, ['h3 a[href]'], 'href'), pageUrl),
      normalizeUrl(firstAttributeValue(card, ['h2 a[href]'], 'href'), pageUrl),
    ]);

    const productName = firstNonEmpty([
      cleanText(firstElementText(card, ['h3 a'])),
      cleanText(firstElementText(card, ['h2 a'])),
      cleanText(firstElementText(card, ['[class*="title"]'])),
      cleanText(firstAttributeValue(card, ['img'], 'alt')),
    ]);
    const rawPrice = firstNonEmpty([
      cleanText(firstElementText(card, ['.product-price'])),
      cleanText(firstElementText(card, ['[class*="price"]'])),
      extractPriceFromNode(card),
    ]);

    if (!sourceUrl || !productName || !rawPrice) {
      continue;
    }

    const comparableName = normalizeComparableText(productName);
    if (/^(catalogo|cat[aá]logo|inicio|home|menu|ver mas|mostrar|pagina)$/i.test(comparableName)) {
      continue;
    }

    products.push({
      productName,
      price: normalizePriceValue(rawPrice),
      currency: inferCurrency(rawPrice),
      description: cleanText(firstElementText(card, ['.product-description', '.product-meta-data'])),
      imageUrl: normalizeUrl(firstNonEmpty(attributeValues(card, ['img'], 'src')), pageUrl),
      sourceUrl,
      availability:
        resolveAvailability(cleanText(card.text) ?? '', rule) === 'in_stock'
          ? 'in_stock'
          : resolveAvailability(cleanText(card.text) ?? '', rule) === 'out_of_stock'
            ? 'out_of_stock'
            : undefined,
      extractedAt: new Date().toISOString(),
      provider,
    });
  }

  return products;
}

function extractChapareiListProducts(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord[] {
  const products: ProductRecord[] = [];
  const articles = queryAll(root, 'article.prod_item');

  for (const article of articles) {
    if (isChapareiOutOfStockCard(article)) {
      continue;
    }

    const sourceUrl = firstNonEmpty([
      normalizeUrl(firstAttributeValue(article, ['a[href*="/catalogo/"]'], 'href'), pageUrl),
      normalizeUrl(firstAttributeValue(article, ['a[itemprop="url"]'], 'href'), pageUrl),
      normalizeUrl(firstAttributeValue(article, ['h2 a'], 'href'), pageUrl),
    ]);

    if (!sourceUrl) {
      continue;
    }

    const productName = extractChapareiListingName(article);
    const rawPrice = extractChapareiListingPrice(article);

    if (!productName || !rawPrice) {
      continue;
    }

    const availabilityText = cleanText([
      firstElementText(article, ['.enstock']),
      firstElementText(article, ['#producto_agotado']),
      firstElementText(article, ['.opcionescarrito']),
      article.text,
    ].filter(Boolean).join(' '));

    products.push({
      productName,
      price: normalizePriceValue(rawPrice),
      currency: inferCurrency(rawPrice),
      brand: extractBrandFromText(cleanText(firstElementText(article, ['.copete_f'])) ?? cleanText(firstElementText(article, ['.copete_ficha']))),
      description: cleanText(firstElementText(article, ['.copete_f'])) ?? cleanText(firstElementText(article, ['.copete_ficha'])),
      imageUrl:
        normalizeUrl(firstAttributeValue(article, ['img'], 'src') ?? firstAttributeValue(article, ['img'], 'data-src') ?? firstAttributeValue(article, ['img'], 'srcset')?.split(',')[0]?.trim().split(' ')[0], pageUrl),
      sourceUrl,
      availability: resolveAvailability(availabilityText ?? '', rule) === 'in_stock'
        ? 'in_stock'
        : resolveAvailability(availabilityText ?? '', rule) === 'out_of_stock'
          ? 'out_of_stock'
          : undefined,
      extractedAt: new Date().toISOString(),
      provider,
    });
  }

  return products;
}

function isChapareiOutOfStockCard(article: HTMLElement): boolean {
  const className = cleanText(article.getAttribute('class')) ?? '';
  if (/\bprod_sin_stock\b/i.test(className)) {
    return true;
  }

  const stockText = cleanText([
    firstElementText(article, ['.stock_agotado']),
    firstElementText(article, ['.agotado']),
    firstElementText(article, ['#producto_agotado']),
  ].filter(Boolean).join(' '));

  return Boolean(stockText && /agotado|sin stock|out of stock|no disponible/i.test(stockText));
}

function extractSelvirListingName(anchor: HTMLElement, card: HTMLElement, cardText: string): string | undefined {
  const source = firstNonEmpty([
    cleanText(anchor.text),
    cleanText(firstElementText(card, ['h1', 'h2', 'h3', 'h4'])),
    cleanText(firstElementText(card, ['[class*="title"]', '[class*="name"]'])),
    cleanText(cardText),
  ]);

  if (!source) {
    return undefined;
  }

  return cleanText(
    source
      .replace(/\bCÃ³digo\b[\s:#-]*\d+\b.*$/i, '')
      .replace(/\b(Disponible|Consulte|Comprar|AÃ±adir al carrito|Anadir al carrito)\b.*$/i, '')
      .replace(/\$\s*[\d.,]+.*$/i, '')
      .replace(/\s+/g, ' '),
  );
}

function extractSelvirListingPrice(cardText: string): string | undefined {
  const matches = Array.from(cardText.matchAll(/(?:US\$|\$|UYU|USD)\s*[\d]{1,3}(?:[.,][\d]{3})*(?:[.,][\d]{1,2})?/gi));
  const lastMatch = matches.at(-1)?.[0];
  return lastMatch ? cleanText(lastMatch) : undefined;
}

function extractSelvirListingNameV2(anchor: HTMLElement, card: HTMLElement, cardText: string): string | undefined {
  const source = firstNonEmpty([
    cleanText(firstElementText(card, ['.product-info-title'])),
    cleanText(anchor.text),
    cleanText(firstElementText(card, ['h1', 'h2', 'h3', 'h4'])),
    cleanText(firstElementText(card, ['[class*="title"]', '[class*="name"]'])),
    cleanText(cardText),
  ]);

  if (!source) {
    return undefined;
  }

  return cleanText(
    source
      .replace(/\bC[oó]d(?:igo)?\b[\s:#-]*[\w.-]+\b.*$/i, '')
      .replace(/\b(?:Disponible|Consulte|Comprar|A[Ã±n]adir al carrito|Agotado|Sin stock|Out of stock|No disponible)\b.*$/i, '')
      .replace(/\$\s*[\d.,]+.*$/i, '')
      .replace(/\s+/g, ' '),
  );
}

function extractSelvirListingPriceV2(card: HTMLElement, cardText: string): string | undefined {
  const priceText = firstNonEmpty([
    cleanText(firstElementText(card, ['.product-info-price .woocommerce-Price-currency'])),
    cleanText(firstElementText(card, ['.product-info-price .woocommerce-Price-amount'])),
    cleanText(firstElementText(card, ['.product-info-price'])),
    cleanText(firstElementText(card, ['[class*="price-number"]'])),
  ]);

  if (priceText && normalizePriceValue(priceText)) {
    return priceText;
  }

  const matches = Array.from(cardText.matchAll(/(?:US\$|\$|UYU|USD)\s*[\d]{1,3}(?:[.,][\d]{3})*(?:[.,][\d]{1,2})?/gi));
  const firstMatch = matches[0]?.[0];
  return firstMatch ? cleanText(firstMatch) : undefined;
}

function extractChapareiListingName(article: HTMLElement): string | undefined {
  const name = firstNonEmpty([
    cleanText(firstElementText(article, ['span[itemprop="name"]'])),
    cleanText(firstElementText(article, ['h1.nombre'])),
    cleanText(firstElementText(article, ['h2 span[itemprop="name"]'])),
    cleanText(firstElementText(article, ['h2 .nombre'])),
    cleanText(firstElementText(article, ['[itemprop="name"]'])),
    cleanText(firstAttributeValue(article, ['img'], 'alt')),
    cleanText(firstElementText(article, ['h2 a'])),
    cleanText(firstElementText(article, ['h1'])),
  ]);

  if (!name) {
    return undefined;
  }

  if (/finalizar compra|agregar al carrito|comprar|ver m[aá]s|ver mas|menu|inicio/i.test(normalizeComparableText(name))) {
    return undefined;
  }

  return name;
}

function extractChapareiListingPrice(article: HTMLElement): string | undefined {
  const rawPrice = firstNonEmpty([
    cleanText(firstElementText(article, ['#precio_ent_actual'])),
    cleanText(firstAttributeValue(article, ['#precio_ent_actual'], 'content')),
    cleanText(firstElementText(article, ['[itemprop="price"]'])),
    cleanText(firstAttributeValue(article, ['[itemprop="price"]'], 'content')),
    cleanText(firstElementText(article, ['.precio_cont .entero'])),
    cleanText(firstElementText(article, ['.prod_preciomas .entero'])),
    cleanText(firstElementText(article, ['.pprecio'])),
    cleanText(firstElementText(article, ['.precio_cont'])),
  ]);

  if (rawPrice && normalizePriceValue(rawPrice)) {
    return rawPrice;
  }

  const text = cleanText(article.text) ?? '';
  const match = text.match(/(?:US\$|\$U|\$|UYU|USD)\s*[\d]{1,3}(?:[.,][\d]{3})*(?:[.,][\d]{1,2})?/i);
  return match?.[0] ? cleanText(match[0]) : undefined;
}

function extractChapareiDetailProduct(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord | undefined {
  if (!isChapareiProductPage(pageUrl, root)) {
    return undefined;
  }

  const title = firstNonEmpty([
    cleanText(firstElementText(root, ['h1.nombre'])),
    cleanText(firstElementText(root, ['h1[itemprop="name"]'])),
    cleanText(firstElementText(root, ['h1'])),
  ]);
  const priceText = firstNonEmpty([
    cleanText(firstElementText(root, ['#precio_ent_actual'])),
    cleanText(firstAttributeValue(root, ['#precio_ent_actual'], 'content')),
    cleanText(firstElementText(root, ['[itemprop="price"]'])),
    cleanText(firstAttributeValue(root, ['[itemprop="price"]'], 'content')),
    cleanText(firstElementText(root, ['.precio_cont .entero'])),
    cleanText(firstElementText(root, ['.prod_preciomas .entero'])),
    cleanText(firstElementText(root, ['.pprecio'])),
  ]);

  if (!title || !priceText) {
    return undefined;
  }

  if (/finalizar compra|agregar al carrito|comprar|ver m[aá]s|ver mas|menu|inicio/i.test(normalizeComparableText(title))) {
    return undefined;
  }

  const pageText = cleanText(firstElementText(root, ['body']) ?? root.text) ?? '';
  if (/(404|page not found|not found|pagina no encontrada|p[aá]gina no encontrada|no se ha podido encontrar)/i.test(pageText)) {
    return undefined;
  }

  const brandText = firstNonEmpty([
    cleanText(firstElementText(root, ['.copete_ficha'])),
    cleanText(firstElementText(root, ['.copete_f'])),
  ]);
  const availabilityText = collectAvailabilityText(root);
  const availability = resolveDetailAvailability(root, availabilityText, rule);

  return {
    productName: title,
    price: normalizePriceValue(priceText),
    currency: inferCurrency(priceText),
    brand: extractBrandFromText(brandText),
    description: cleanText(firstElementText(root, ['.copete_ficha', '.copete_f'])),
    imageUrl:
      normalizeUrl(firstNonEmpty(attributeValues(root, ['figure img', '.prod_cont img', '.foto img', 'img'], 'src')), pageUrl)
      ?? normalizeUrl(firstAttributeValue(root, ['meta[property="og:image"]'], 'content'), pageUrl),
    sourceUrl: pageUrl,
    availability:
      availability === 'in_stock'
        ? 'in_stock'
        : availability === 'out_of_stock'
          ? 'out_of_stock'
          : resolveAvailability([availabilityText, pageText].filter(Boolean).join(' '), rule) === 'in_stock'
            ? 'in_stock'
            : resolveAvailability([availabilityText, pageText].filter(Boolean).join(' '), rule) === 'out_of_stock'
              ? 'out_of_stock'
              : undefined,
    extractedAt: new Date().toISOString(),
    provider,
  };
}

function isSelvirProductCard(href: string, card: HTMLElement, cardText: string): boolean {
  if (!/\/product\//i.test(href) || /\/product-category\//i.test(href)) {
    return false;
  }

  const hasStructuredTitle = queryAll(card, '.product-info-title').length > 0;
  const hasStructuredPrice = queryAll(card, '.product-info-price').length > 0 || queryAll(card, '.price-number').length > 0;
  const hasPriceText = Boolean(normalizePriceValue(cardText));

  return (hasStructuredTitle || hasStructuredPrice) && hasPriceText;
}

function extractSelvirDetailProduct(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord | undefined {
  if (!/\/product\//i.test(pageUrl)) {
    return undefined;
  }

  const title = firstNonEmpty(selectText(root, ['h1.product-info-title', 'h1.product_title', 'h1']));
  if (!title) {
    return undefined;
  }

  const priceText = firstNonEmpty([
    cleanText(firstElementText(root, ['.product-info-price .price-number'])),
    cleanText(firstElementText(root, ['.product-info-price .woocommerce-Price-amount'])),
    cleanText(firstElementText(root, ['.product-info-price'])),
    cleanText(firstElementText(root, ['.summary .price-number'])),
    cleanText(firstElementText(root, ['[class*="price-number"]'])),
  ]);

  const pageText = cleanText(firstElementText(root, ['body']) ?? root.text) ?? '';
  if (/(404|page not found|not found|pagina no encontrada|p[aÃƒÂ¡]gina no encontrada|no se ha podido encontrar)/i.test(pageText)) {
    return undefined;
  }
  const availabilityText = collectAvailabilityText(root);
  const availability = resolveDetailAvailability(root, availabilityText, rule);
  const brandText = firstNonEmpty(selectText(root, ['.product-info-brand', '.brand', '.copete_ficha']));
  const description = firstNonEmpty(selectText(root, ['#tab-description', '.woocommerce-product-details__short-description', '.summary p', 'meta[name="description"]']));

  return {
    productName: title,
    price: priceText ? normalizePriceValue(priceText) : undefined,
    currency: priceText ? inferCurrency(priceText) : undefined,
    brand: extractBrandFromText(brandText),
    description,
    imageUrl:
      normalizeUrl(firstNonEmpty(attributeValues(root, ['figure img', '.woocommerce-product-gallery img', 'img'], 'src')), pageUrl)
      ?? normalizeUrl(firstAttributeValue(root, ['meta[property="og:image"]'], 'content'), pageUrl),
    sourceUrl: pageUrl,
    availability:
      availability === 'in_stock'
        ? 'in_stock'
        : availability === 'out_of_stock'
          ? 'out_of_stock'
          : resolveAvailability([availabilityText, pageText].filter(Boolean).join(' '), rule) === 'in_stock'
            ? 'in_stock'
            : resolveAvailability([availabilityText, pageText].filter(Boolean).join(' '), rule) === 'out_of_stock'
              ? 'out_of_stock'
              : undefined,
    extractedAt: new Date().toISOString(),
    provider,
  };
}

function findSelvirCardContainer(anchor: HTMLElement): HTMLElement {
  return (
    anchor.querySelector('.product-item-container')
    ?? anchor.querySelector('.product-info')
    ?? anchor.querySelector('.item')
    ?? anchor
  );
}

function findChapareiCardContainer(anchor: HTMLElement): HTMLElement {
  return (
    findAncestorWithClass(anchor, 'article', 'prod_item')
    ?? findAncestorWithClass(anchor, 'div', 'prod_item')
    ?? findAncestorWithClass(anchor, 'article', 'prod_cont')
    ?? anchor
  );
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
  if (/(404|page not found|not found|pagina no encontrada|p[aÃ¡]gina no encontrada|no se ha podido encontrar)/i.test(pageText)) {
    return undefined;
  }
  const availabilityText = collectAvailabilityText(root);
  const availability = resolveDetailAvailability(root, availabilityText, rule);
  const brandText = firstNonEmpty(selectText(root, rule.detailSelectors?.brand ?? []));
  const skuText = firstNonEmpty(selectText(root, rule.detailSelectors?.sku ?? []));


  return {
    productName: title,
    price: normalizePriceValue(rawPrice),
    currency: inferCurrency(rawPrice),
    brand: extractBrandFromText(brandText),
    sku: cleanText(skuText?.match(/(?:sku|c[oó]d(?:igo)?\.?)\s*[:#-]?\s*([\w.-]+)/i)?.[1]),
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

function findAncestorWithClass(node: HTMLElement, tagName: string, className: string): HTMLElement | undefined {
  let current: HTMLElement | null = node;

  while (current) {
    const currentTag = current.rawTagName?.toLowerCase();
    const currentClass = String(current.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter(Boolean);

    if (currentTag === tagName.toLowerCase() && currentClass.includes(className)) {
      return current;
    }

    const parentNode: unknown = current.parentNode;
    current = parentNode instanceof HTMLElement ? parentNode : null;
  }

  return undefined;
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

function safePathname(value: string): string | undefined {
  try {
    return new URL(value).pathname.toLowerCase();
  } catch {
    return undefined;
  }
}

function safeHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
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
    /comprar|agregar al carrito|consultar|iva inc|en stock|agotado|c[oÃ³]d|precio|producto|repuesto|articulo|ficha/i.test(
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
  const looksLikeProduct = Boolean(normalizePriceValue(cardText)) || /comprar|agregar al carrito|consultar|c[oÃ³]d/i.test(loweredText);

  return hasCategorySignal && !looksLikeProduct;
}

function isLikelyDetailPage(root: HTMLElement, pageUrl: string, rule: DomainRule): boolean {
  if (rule.id === 'chaparei' && queryAll(root, 'article.prod_item').length > 1) {
    return false;
  }

  if (rule.id === 'taxitor') {
    const paginationLinkCount = queryAll(root, 'ul.pagination a[href]').length;
    const productLinkCount = queryAll(root, 'a[href]').reduce((count, anchor) => {
      const href = normalizeUrl(anchor.getAttribute('href'), pageUrl);
      if (!href || !rule.productUrlPatterns.some((pattern) => pattern.test(href))) {
        return count;
      }

      return count + 1;
    }, 0);

    if (paginationLinkCount > 0 || productLinkCount > 1) {
      return false;
    }
  }

  if (rule.id === 'feyvi') {
    if (queryAll(root, '.ty-grid-list__item, .ty-pagination__items, .ty-pagination__item').length > 0) {
      return false;
    }

    const productLinkCount = queryAll(root, 'a[href]').reduce((count, anchor) => {
      const href = normalizeUrl(anchor.getAttribute('href'), pageUrl);
      if (!href || !rule.productUrlPatterns.some((pattern) => pattern.test(href))) {
        return count;
      }

      return count + 1;
    }, 0);

    if (productLinkCount > 1) {
      return false;
    }
  }

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

function isFeyviUiLabel(productName: string, cardText: string, href: string): boolean {
  const normalizedName = normalizeComparableText(productName);
  const normalizedCardText = normalizeComparableText(cardText);
  const normalizedHref = href.toLowerCase();
  const uiLabelPatterns = [
    /^(ordenar por|total productos(?:\s+\d+)?|mostrar(?:\s+\d+)?|ver mas|ver mas productos|filtros?|resultados|categoria(?:s)?|pagina(?:\s+\d+)?)$/,
    /^\d+\s+productos?\s+mas$/,
    /^productos?\s+mas$/,
    /^\d+\s+mas$/,
  ];

  if (uiLabelPatterns.some((pattern) => pattern.test(normalizedName))) {
    return true;
  }

  if (uiLabelPatterns.some((pattern) => pattern.test(normalizedCardText))) {
    return true;
  }

  if (/sort(?:_|-)?by|orderby|filter|filters|pagination|page-\d+/i.test(normalizedHref)) {
    return true;
  }

  return false;
}

function isChapareiProductPage(pageUrl: string, root: HTMLElement): boolean {
  if (!/\/catalogo\/[^/?#]+\/.+\/?$/i.test(pageUrl)) {
    return false;
  }

  const articleCount = queryAll(root, 'article.prod_item').length;
  return articleCount <= 1;
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
