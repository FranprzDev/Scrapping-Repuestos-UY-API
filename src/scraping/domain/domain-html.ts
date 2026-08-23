import { HTMLElement, parse } from 'node-html-parser';
import { ProductRecord, ProviderName } from '../interfaces/scraping.types';
import { DomainRule } from './domain-rules';
import { cleanText, inferCurrency, isAllowedCatalogUrl, normalizePriceValue, resolveAvailability } from './product-quality';
import { extractItalurCategoryUrls, extractItalurDetail, extractItalurListProducts, extractItalurProductUrls } from './italur';

const GENERIC_PRICE_SELECTORS = ['.price', '[class*="price"]', '[class*="precio"]', '.woocommerce-Price-amount'];

export function extractCandidateLinks(html: string, baseUrl: string, rule: DomainRule): { productLinks: string[]; categoryLinks: string[] } {
  if (rule.id === 'italur') {
    return {
      productLinks: extractItalurProductUrls(html, baseUrl),
      categoryLinks: extractItalurCategoryUrls(html, baseUrl),
    };
  }

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

    if (rule.categoryUrlPatterns.some((pattern) => pattern.test(href))) {
      categoryLinks.add(href);
      return;
    }

    const card = findCardContainer(anchor);
    const cardText = cleanText(card.text) ?? '';
    if (isSemanticProductLink(href, cardText, rule)) {
      if (rule.id === 'feyvi' && !rule.productUrlPatterns.some((pattern) => pattern.test(href))) {
        return;
      }
      productLinks.add(href);
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

  if (rule.id === 'selvir' && /\/product\//i.test(pageUrl)) {
    const detailProduct = extractSelvirDetailProduct(root, pageUrl, provider, rule);
    return detailProduct ? [detailProduct] : extractJsonLdProducts(root, pageUrl, provider);
  }

  const candidates: ProductRecord[] = [];

  candidates.push(...extractJsonLdProducts(root, pageUrl, provider));

  if (rule.id === 'italur') {
    const detailProduct = extractItalurDetail(html, pageUrl, provider);
    if (detailProduct) {
      candidates.push(detailProduct);
    } else {
      candidates.push(...extractItalurListProducts(html, pageUrl, provider));
    }
    return candidates;
  }

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

  if (rule.id === 'grfrenos') {
    const listingProducts = extractGrFrenosListingProducts(root, pageUrl, provider, rule);
    if (listingProducts.length > 0) {
      candidates.push(...listingProducts);
      return candidates;
    }

    const detailProduct = extractDetailProduct(root, pageUrl, provider, rule);
    if (detailProduct) {
      candidates.push(detailProduct);
    }

    return candidates;
  }

  if (rule.id === 'europarts') {
    candidates.push(...extractEuropartsListProducts(root, pageUrl, provider, rule));
    return candidates;
  }

  if (rule.id === 'autopartesmagallanes') {
    // Don't use generic JSON-LD extraction - use site-specific WooCommerce extractor only
    // This prevents duplicate products (JSON-LD + HTML extraction)
    candidates.length = 0;
    
    const detailProduct = extractMagallanesDetailProduct(root, pageUrl, provider, rule);
    if (detailProduct) {
      candidates.push(detailProduct);
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

export function extractCompatibilityFromHtml(html: string): Pick<ProductRecord, 'compatibleVehicles' | 'compatibleBrands' | 'compatibleModels' | 'compatibleVersions'> {
  const root = parse(html);
  return extractCompatibilityFromRoot(root);
}

function extractCompatibilityFromRoot(root: HTMLElement): Pick<ProductRecord, 'compatibleVehicles' | 'compatibleBrands' | 'compatibleModels' | 'compatibleVersions'> {
  const vehicleTexts = new Set<string>();
  const brands = new Set<string>();
  const models = new Set<string>();
  const versions = new Set<string>();

  for (const row of root.querySelectorAll('table.rssTable tr.relatedSpecialSearchRow, table tr')) {
    const cells = new Map(
      row.querySelectorAll('td[data-label]').map((cell) => [
        normalizeCompatibilityLabel(cell.getAttribute('data-label')),
        cleanText(cell.text),
      ]),
    );
    const brand = cells.get('marca');
    const model = cells.get('modelo');
    const version = cells.get('motor ano') ?? cells.get('motor / ano');
    if (!brand && !model && !version) {
      continue;
    }
    if (brand) brands.add(brand);
    if (model) models.add(model);
    if (version) versions.add(version);
    vehicleTexts.add([brand, model, version].filter(Boolean).join(' - '));
  }

  for (const table of root.querySelectorAll('.table_obs table, table.modal-marcas-modelos')) {
    const headers = table.querySelectorAll('thead th').map((header) => normalizeCompatibilityLabel(header.text));
    const brandIndex = headers.findIndex((header) => header === 'marca');
    const modelIndex = headers.findIndex((header) => header === 'modelo');
    if (brandIndex < 0 || modelIndex < 0) continue;

    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = row.querySelectorAll('td').map((cell) => cleanText(cell.text));
      const brand = cells[brandIndex];
      const model = cells[modelIndex];
      if (brand) brands.add(brand);
      if (model) models.add(model);
      if (brand && model) vehicleTexts.add(`${brand} - ${model}`);
    }
  }

  for (const item of root.querySelectorAll('.blkCaracteristicas .it, .lstCaracteristicas .it')) {
    const title = cleanText(item.querySelector('.tit')?.text);
    const value = cleanText(item.querySelector('.val')?.text);
    const text = cleanText(title && value ? `${title} ${value}` : item.text);
    if (!text) continue;
    const modelMatch = text.match(/^modelos?\s+(.+)$/i);
    const brandMatch = text.match(/^compatibilidad\s+(.+)$/i);
    const versionMatch = text.match(/^versiones?\s+(.+)$/i);
    if (modelMatch) splitCompatibilityValues(modelMatch[1]).forEach((value) => models.add(value));
    if (brandMatch) splitCompatibilityValues(brandMatch[1]).forEach((value) => brands.add(value));
    if (versionMatch) splitCompatibilityValues(versionMatch[1]).forEach((value) => versions.add(value));
  }

  for (const itemText of root.querySelectorAll('.item-texto')) {
    let currentBrand: string | undefined;
    for (const paragraph of itemText.querySelectorAll('p')) {
      const text = cleanText(paragraph.text);
      if (!text) continue;
      const brandMatch = text.match(/^marca\s*:\s*(.+)$/i);
      const modelMatch = text.match(/^modelos?\s*:\s*(.+)$/i);
      if (brandMatch) {
        currentBrand = cleanText(brandMatch[1]);
        if (currentBrand) brands.add(currentBrand);
      } else if (modelMatch) {
        const values = splitCompatibilityValues(modelMatch[1]);
        values.forEach((value) => models.add(value));
        if (currentBrand) values.forEach((value) => vehicleTexts.add(`${currentBrand} - ${value}`));
      }
    }
  }

  for (const group of root.querySelectorAll('.ty-product-feature-group')) {
    const groupLabel = cleanText(group.querySelector('.ty-subheader, .ty-product-feature__label, h3')?.text);
    if (normalizeCompatibilityLabel(groupLabel) !== 'modelo') continue;

    for (const feature of group.querySelectorAll('.ty-product-feature')) {
      const label = feature.querySelector('.ty-product-feature__label')?.clone() as HTMLElement | undefined;
      label?.querySelectorAll('.ty-help-info, .hidden').forEach((element) => element.remove());
      const brand = cleanText(label?.text)?.replace(/\s*:\s*$/, '');
      if (!brand || /^(fabricante|marca|modelo)$/i.test(brand)) continue;
      const values = feature.querySelectorAll('.ty-product-feature__multiple-item').map((item) => cleanText(item.text)).filter((value): value is string => Boolean(value));
      if (values.length === 0) continue;
      brands.add(brand);
      values.forEach((value) => {
        models.add(value);
        vehicleTexts.add(`${brand} - ${value}`);
      });
    }
  }

  for (const section of root.querySelectorAll('.producto__info--modelos')) {
    if (!/^modelos? compatibles\s*:/i.test(cleanText(section.querySelector('h3')?.text) ?? '')) continue;
    for (const line of section.querySelectorAll('.producto__info--modelos--linea')) {
      const lineText = cleanText(line.text) ?? '';
      const match = lineText.match(/^([^:]+):\s*(.+)$/);
      const brand = cleanText(line.querySelector('h4')?.text)?.replace(/\s*:\s*$/, '') ?? cleanText(match?.[1]);
      const values = splitCompatibilityValues(cleanText(line.querySelector('h5')?.text) ?? match?.[2] ?? '');
      if (!brand || values.length === 0) continue;
      brands.add(brand);
      values.forEach((value) => {
        models.add(value);
        vehicleTexts.add(`${brand} - ${value}`);
      });
    }
  }

  const selectors = [
    '[class*="compat"]', '[id*="compat"]', '[class*="vehicul"]', '[id*="vehicul"]',
    '[class*="aplicacion"]', '[id*="aplicacion"]', '.modelo', '[id*="modelo"]', '[class*="version"]', '[id*="version"]',
    '.gendataminitit', 'a.block[href*="showmod"]', '.blkCaracteristicas .it', '.lstCaracteristicas .it', '.item-texto',
  ];

  for (const element of root.querySelectorAll(selectors.join(','))) {
    const marker = `${element.getAttribute('class') ?? ''} ${element.getAttribute('id') ?? ''}`;
    const textMarker = `${marker} ${element.text}`;
    if (!/(compat|veh[ií]culo|aplicaci[oó]n|modelo|versi[oó]n|showmod)/i.test(`${textMarker} ${element.getAttribute('href') ?? ''}`)) {
      continue;
    }

    const children = element.querySelectorAll('p,li,td,dd');
    const texts = children.length > 0 ? children.map((child) => child.text) : [element.text];
    for (const rawText of texts) {
      const text = cleanText(rawText);
      if (!text || text.length > 800) {
        continue;
      }

      if (/(compat|aplicaci[oó]n)/i.test(marker)) {
        splitCompatibilityValues(text).forEach((value) => vehicleTexts.add(value));
      }
      if (/(modelo|showmod)/i.test(`${marker} ${element.getAttribute('href') ?? ''}`)) {
        splitCompatibilityValues(text.replace(/^[^:]{0,80}:/, '')).forEach((value) => {
          models.add(value);
          if (/showmod/i.test(element.getAttribute('href') ?? '')) {
            versions.add(value);
          }
        });
      }
      if (/versi[oó]n/i.test(marker)) {
        splitCompatibilityValues(text.replace(/^[^:]{0,80}:/, '')).forEach((value) => versions.add(value));
      }
    }
  }

  return {
    compatibleVehicles: valuesOrUndefined(vehicleTexts),
    compatibleBrands: valuesOrUndefined(brands),
    compatibleModels: valuesOrUndefined(models),
    compatibleVersions: valuesOrUndefined(versions),
  };
}

function normalizeCompatibilityLabel(value?: string): string {
  return (value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function splitCompatibilityValues(value: string): string[] {
  return value
    .split(/[\n;,|•]+/)
    .map((part) => cleanText(part))
    .filter((part): part is string => Boolean(part))
    .filter((part) => part.length >= 2 && part.length <= 240)
    .filter((part) => !/^(modelo\.{0,3}|buscar|todos los modelos|seleccione la marca|ver modelos)$/i.test(part))
    .filter((part) => !/^(compatibilidad|veh[ií]culos?|aplicaci[oó]n|modelos?|versiones?)\s*:?[\s-]*$/i.test(part));
}

function valuesOrUndefined(values: Set<string>): string[] | undefined {
  return values.size > 0 ? Array.from(values) : undefined;
}

function extractEuropartsListProducts(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord[] {
  const products: ProductRecord[] = [];

  root.querySelectorAll('.product-item').forEach((card) => {
    const productLink = card.querySelector('.pi-text a[href*="/product/"]') ?? card.querySelector('a[href*="/product/"]');
    const sourceUrl = normalizeUrl(productLink?.getAttribute('href'), pageUrl);
    const productName = cleanText(card.querySelector('.pi-text h5')?.text) ?? cleanText(card.querySelector('img[alt]')?.getAttribute('alt'));
    const rawPrice = cleanText(card.querySelector('.product-price')?.text);

    if (!sourceUrl || !productName || !rawPrice || !rule.productUrlPatterns.some((pattern) => pattern.test(sourceUrl))) {
      return;
    }

    products.push({
      productName,
      price: normalizePriceValue(rawPrice),
      currency: inferCurrency(rawPrice),
      category: cleanText(card.querySelector('.catagory-name')?.text),
      imageUrl: normalizeUrl(
        card.querySelector('img')?.getAttribute('data-src') ?? card.querySelector('img')?.getAttribute('src'),
        pageUrl,
      ),
      sourceUrl,
      availability: 'in_stock',
      extractedAt: new Date().toISOString(),
      provider,
    });
  });

  return products;
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

export function extractGrFrenosBrandsFromHtml(html: string, baseUrl: string): Array<{ brandId: string; brandLabel: string; sourceUrl: string }> {
  const root = parse(html);
  const brands: Array<{ brandId: string; brandLabel: string; sourceUrl: string }> = [];

  root.querySelectorAll('select#marcax option[value]').forEach((option) => {
    const brandId = cleanText(option.getAttribute('value'));
    const brandLabel = normalizeGrFrenosLabel(option.text);

    if (!brandId || !brandLabel || brandLabel.toLowerCase() === 'seleccione la marca') {
      return;
    }

    if (!/^\d+$/.test(brandId)) {
      return;
    }

    brands.push({
      brandId,
      brandLabel,
      sourceUrl: buildGrFrenosBrandUrl(baseUrl, brandId),
    });
  });

  return brands;
}

export function extractGrFrenosListingSummary(body: string): { brandLabel?: string; totalResults?: number } | undefined {
  const root = parse(body);
  const title = normalizeGrFrenosLabel(
    root.querySelector('.niveles__cabezal--titulo h1')?.text
      ?? root.querySelector('.niveles__cabezal--titulo h2')?.text
      ?? root.querySelector('h1')?.text,
  );
  const totalText = cleanText(
    root.querySelector('.niveles__cabezal--titulo h3')?.text
      ?? root.querySelector('.niveles__cabezal--tools--paginacionton')?.text,
  );

  if (!title && !totalText) {
    return undefined;
  }

  const totalResults = totalText ? parseResultCount(totalText) : undefined;
  return {
    brandLabel: title,
    totalResults,
  };
}

export function buildGrFrenosBrandUrl(baseUrl: string, brandId: string, totalResults?: number): string {
  const url = new URL('/buscardor.php', baseUrl);
  url.searchParams.set('marcas', `${brandId}---`);
  if (typeof totalResults === 'number' && Number.isFinite(totalResults) && totalResults > 0) {
    url.searchParams.set('paginacion', String(totalResults));
  }

  return url.toString();
}

export function isGrFrenosChallengeHtml(body: string): boolean {
  const text = normalizeComparableText(cleanText(body) ?? '');
  if (!text) {
    return false;
  }

  return /cloudflare|access denied|forbidden|captcha|verify you are human|just a moment|security check|anti bot|robot/.test(text);
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
  if (rule.id === 'selvir') {
    return extractSelvirListProducts(root, pageUrl, provider, rule);
  }

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

    if (rule.id === 'feyvi' && !rule.productUrlPatterns.some((pattern) => pattern.test(href))) {
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

    const imageUrls = rule.id === 'feyvi'
      ? extractFeyviImages(card, pageUrl)
      : uniqueStrings([
          normalizeUrl(firstAttributeValue(card, ['img'], 'src') ?? firstAttributeValue(card, ['img'], 'data-src'), pageUrl),
        ].filter((value): value is string => Boolean(value)));

    products.push({
      productName,
      price: normalizePriceValue(rawPrice),
      currency: inferCurrency(rawPrice),
      description: cleanText(firstElementText(card, ['p'])),
      imageUrl: imageUrls[0],
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
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

function extractSelvirListProducts(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord[] {
  const products: ProductRecord[] = [];
  const seen = new Set<string>();

  for (const card of root.querySelectorAll('.product-item-container')) {
    let parentAnchor: HTMLElement | undefined = card.parentNode;
    while (parentAnchor && parentAnchor.rawTagName?.toLowerCase() !== 'a') {
      parentAnchor = parentAnchor.parentNode;
    }
    if (parentAnchor?.rawTagName?.toLowerCase() !== 'a') {
      parentAnchor = undefined;
    }
    const productAnchor = card.querySelector('a[href*="/product/"]') ?? parentAnchor;
    const sourceUrl = normalizeUrl(productAnchor?.getAttribute('href'), pageUrl);
    if (!sourceUrl || seen.has(sourceUrl) || !isAllowedCatalogUrl(sourceUrl, pageUrl)) {
      continue;
    }

    const cardText = cleanText(card.text) ?? '';
    if (!isSelvirProductCard(sourceUrl, card, cardText)) {
      continue;
    }

    const productName = extractSelvirListingNameV2(productAnchor ?? card, card, cardText);
    if (!productName) {
      continue;
    }

    const rawPrice = extractSelvirListingPriceV2(card, cardText) ?? extractPriceFromNode(card);
    const imageUrls = extractSelvirListingImageUrls(card, pageUrl);

    seen.add(sourceUrl);
    products.push({
      productName,
      price: normalizePriceValue(rawPrice),
      currency: inferCurrency(rawPrice),
      description: cleanText(firstElementText(card, ['p'])),
      imageUrl: imageUrls[0],
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      sourceUrl,
      availability:
        resolveAvailability(cardText, rule) === 'in_stock'
          ? 'in_stock'
          : resolveAvailability(cardText, rule) === 'out_of_stock'
            ? 'out_of_stock'
            : undefined,
      extractedAt: new Date().toISOString(),
      provider,
    });
  }

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

function extractGrFrenosListingProducts(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord[] {
  const products: ProductRecord[] = [];
  const cards = queryAll(root, 'article.card__producto--item');

  for (const card of cards) {
    const sourceUrl = firstNonEmpty([
      normalizeUrl(firstAttributeValue(card, ['h3 a[href]'], 'href'), pageUrl),
      normalizeUrl(firstAttributeValue(card, ['.card__producto--item--img a[href]'], 'href'), pageUrl),
      normalizeUrl(firstAttributeValue(card, ['.card__producto--item--info--titulo a[href]'], 'href'), pageUrl),
    ]);

    const productName = firstNonEmpty([
      cleanText(firstElementText(card, ['h3 a'])),
      cleanText(firstAttributeValue(card, ['img'], 'alt')),
      cleanText(firstElementText(card, ['.card__producto--item--info--titulo'])),
    ]);

    if (!sourceUrl || !productName) {
      continue;
    }

    if (normalizeComparableText(productName).includes('ver modelos')) {
      continue;
    }

    const rawPrice = firstNonEmpty([
      cleanText(firstElementText(card, ['.card__producto--item--info--tools--pie h4'])),
      cleanText(firstElementText(card, ['.card__producto--item--info--tools--pie .precio'])),
      cleanText(firstElementText(card, ['.card__producto--item--info--tools--pie [class*="precio"]'])),
      cleanText(firstElementText(card, ['h4'])),
    ]);

    if (!rawPrice || !normalizePriceValue(rawPrice)) {
      continue;
    }

    const compatibleBrands = Array.from(
      new Set(
        queryAll(card, '.card__producto--item--info--titulo--modelos--linea--marcas h5')
          .map((element) => normalizeGrFrenosLabel(element.text))
          .filter((value): value is string => Boolean(value)),
      ),
    );

    products.push({
      productName,
      price: normalizePriceValue(rawPrice),
      currency: inferCurrency(rawPrice),
      compatibleBrands: compatibleBrands.length > 0 ? compatibleBrands : undefined,
      description: cleanText(firstElementText(card, ['.card__producto--item--info--titulo--modelos--linea--marcas'])),
      imageUrl:
        normalizeUrl(
          firstAttributeValue(card, ['img'], 'src')
            ?? firstAttributeValue(card, ['img'], 'data-src')
            ?? firstAttributeValue(card, ['img'], 'srcset')?.split(',')[0]?.trim().split(' ')[0],
          pageUrl,
        ),
      sourceUrl,
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
    const isOutOfStock = isChapareiOutOfStockCard(article);

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

    if (!productName) {
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
      sku: extractChapareiSku(article, sourceUrl),
      description: cleanText(firstElementText(article, ['.copete_f'])) ?? cleanText(firstElementText(article, ['.copete_ficha'])),
      imageUrl:
        normalizeUrl(firstAttributeValue(article, ['img'], 'src') ?? firstAttributeValue(article, ['img'], 'data-src') ?? firstAttributeValue(article, ['img'], 'srcset')?.split(',')[0]?.trim().split(' ')[0], pageUrl),
      sourceUrl,
      availability: isOutOfStock
        ? 'out_of_stock'
        : resolveAvailability(availabilityText ?? '', rule) === 'in_stock'
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

  if (!title) {
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
    sku: extractChapareiSku(root, pageUrl),
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

function extractChapareiSku(root: HTMLElement, sourceUrl: string): string | undefined {
  const explicit = firstNonEmpty([
    cleanText(firstElementText(root, ['[itemprop="sku"]'])),
    cleanText(firstAttributeValue(root, ['[itemprop="sku"]'], 'content')),
    cleanText(firstElementText(root, ['.sku', '.codigo', '.cod_producto', '[class*="codigo"]'])),
  ]);
  const explicitMatch = explicit?.match(/(?:sku|c[oó]d(?:igo)?(?:\s+del\s+producto)?)?\s*[:#-]?\s*([a-z]\d{5,}|[a-z0-9][a-z0-9._-]{4,})/i);
  if (explicitMatch?.[1]) {
    return explicitMatch[1].toUpperCase();
  }

  try {
    const slug = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1);
    const slugMatch = slug?.match(/(?:^|-)([a-z]\d{5,})$/i);
    return slugMatch?.[1]?.toUpperCase();
  } catch {
    return undefined;
  }
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

function extractMagallanesDetailProduct(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord | undefined {
  // Magallanes product URLs have -ref- in them
  if (!/\-ref\-/i.test(pageUrl)) {
    return undefined;
  }

  // Extract product title from h1 - this is the key identifier for a real product page
  const titleEl = root.querySelector('h1.product_title, h1.product-title, h1');
  if (!titleEl) {
    return undefined;
  }

  const title = cleanText(titleEl.text);
  if (!title) {
    return undefined;
  }

  // Extract price - ALLOW UNDEFINED (some products may not have public pricing)
  let priceText: string | undefined;
  const priceSelectors = [
    '.woocommerce-Price-amount',
    '.product-price',
    '.price',
    '[data-price]',
    '.product_price',
  ];

  for (const selector of priceSelectors) {
    const priceEl = root.querySelector(selector);
    if (priceEl) {
      const text = cleanText(priceEl.text);
      // Accept price even if it's just "...", as it indicates a price section exists
      if (text && text.length > 0 && text !== '...') {
        priceText = text;
        break;
      }
    }
  }

  // Extract primary image
  const imageSelectors = [
    'img.wp-post-image',
    'img[data-lazy-src]',
    'img[data-src]',
    'figure img',
    '.product-image img',
  ];

  let imageUrl: string | undefined;
  for (const selector of imageSelectors) {
    const imgEl = root.querySelector(selector);
    if (imgEl) {
      imageUrl = normalizeUrl(
        imgEl.getAttribute('data-lazy-src') || imgEl.getAttribute('data-src') || imgEl.getAttribute('src'),
        pageUrl,
      );
      if (imageUrl && !imageUrl.includes('placeholder')) break;
    }
  }

  // If no image found with lazy-loading attrs, try standard img src
  if (!imageUrl) {
    const firstImg = root.querySelector('img[src]');
    if (firstImg && !firstImg.getAttribute('src')?.includes('placeholder')) {
      imageUrl = normalizeUrl(firstImg.getAttribute('src'), pageUrl);
    }
  }

  // Extract availability from button or text
  const availabilityText = collectAvailabilityText(root);
  const availability = resolveDetailAvailability(root, availabilityText, rule);

  // Extract description
  const description = firstNonEmpty(
    selectText(root, [
      '.woocommerce-product-details__short-description',
      '.product-description',
      '#tab-description',
      '.summary p',
    ]),
  );

  // Return product even if price is undefined - this is a valid product page
  return {
    productName: title,
    price: priceText ? normalizePriceValue(priceText) : undefined,
    currency: priceText ? inferCurrency(priceText) : undefined,
    description,
    imageUrl,
    sourceUrl: pageUrl,
    availability:
      availability === 'in_stock'
        ? 'in_stock'
        : availability === 'out_of_stock'
          ? 'out_of_stock'
          : resolveAvailability([availabilityText].filter(Boolean).join(' '), rule) === 'in_stock'
            ? 'in_stock'
            : resolveAvailability([availabilityText].filter(Boolean).join(' '), rule) === 'out_of_stock'
              ? 'out_of_stock'
              : undefined,
    extractedAt: new Date().toISOString(),
    provider,
  };
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
  const imageUrls = extractSelvirDetailImageUrls(root, pageUrl);

  return {
    productName: title,
    price: priceText ? normalizePriceValue(priceText) : undefined,
    currency: priceText ? inferCurrency(priceText) : undefined,
    brand: extractBrandFromText(brandText),
    description,
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
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

function extractSelvirListingImageUrls(card: HTMLElement, pageUrl: string): string[] {
  const urls: string[] = [];

  for (const image of card.querySelectorAll('img')) {
    urls.push(
      largestSrcsetCandidate(image.getAttribute('srcset')) ?? '',
      image.getAttribute('data-src') ?? '',
      image.getAttribute('data-lazy-src') ?? '',
      image.getAttribute('src') ?? '',
    );
  }

  return uniqueStrings(
    urls
      .map((value) => validSelvirImageUrl(value, pageUrl))
      .filter((value): value is string => Boolean(value)),
  );
}

function extractSelvirDetailImageUrls(root: HTMLElement, pageUrl: string): string[] {
  const gallery = root.querySelector('.woocommerce-product-gallery');
  const urls: string[] = [];

  if (gallery) {
    urls.push(
      ...attributeValues(gallery, ['a.product-zoom-link[href]'], 'href'),
      ...attributeValues(gallery, ['picture source[srcset]'], 'srcset').map(largestSrcsetCandidate).filter((value): value is string => Boolean(value)),
      ...attributeValues(gallery, ['img.wp-post-image[src]'], 'src'),
    );
  }

  urls.push(firstAttributeValue(root, ['meta[property="og:image"]'], 'content') ?? '');

  return uniqueStrings(
    urls
      .map((value) => validSelvirImageUrl(value, pageUrl))
      .filter((value): value is string => Boolean(value)),
  );
}

function validSelvirImageUrl(value: string | undefined, pageUrl: string): string | undefined {
  const fixedValue = value?.replace(/^https?:\/\/(?:www\.)?selvir\.com\.uy\/(https?:\/\/.+)$/i, '$1');
  const url = normalizeUrl(fixedValue, pageUrl);
  if (!url) {
    return undefined;
  }

  const comparable = url.toLowerCase();
  if (/(?:producto3\.gif|logo|favicon|whatsapp|placeholder|no-image|sin-imagen|header|footer|icon)/i.test(comparable)) {
    return undefined;
  }
  if (!/\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url)) {
    return undefined;
  }

  return url;
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

  if (rule.id === 'feyvi') {
    return extractFeyviDetailProduct(root, pageUrl, provider, rule);
  }

  const title = firstNonEmpty(selectText(root, rule.detailSelectors?.title ?? ['h1']));
  const rawPrice = firstNonEmpty(selectText(root, [...(rule.detailSelectors?.price ?? []), ...GENERIC_PRICE_SELECTORS]));
  if (!title) {
    return undefined;
  }

const pageText = cleanText(firstElementText(root, ['body']) ?? root.text) ?? '';
const pageTitle = cleanText(firstElementText(root, ['title']) ?? '');
const mainHeading = cleanText(firstElementText(root, ['h1']) ?? '');

if (
  /(404|page not found|pagina no encontrada|p[a\u00e1]gina no encontrada|no se ha podido encontrar)/i.test(pageTitle ?? '')
  || /^(404|page not found|pagina no encontrada|p[a\u00e1]gina no encontrada|no se ha podido encontrar)$/i.test(mainHeading ?? '')
) {
  return undefined;
}
  const availabilityText = collectAvailabilityText(root);
  const availability = resolveDetailAvailability(root, availabilityText, rule);
  const brandText = firstNonEmpty(selectText(root, rule.detailSelectors?.brand ?? []));
  const skuText = firstNonEmpty(selectText(root, rule.detailSelectors?.sku ?? []));
 const imageUrls = rule.id === 'repuestosavenida'
  ? extractRepuestosAvenidaImages(root, pageUrl)
  : rule.id === 'diegoradiadores'
    ? extractDiegoRadiadoresImages(root, pageUrl)
    : isFenicioRule(rule)
      ? extractFenicioDetailImages(root, pageUrl)
      : uniqueStrings(
          attributeValues(root, rule.detailSelectors?.image ?? ['img'], 'src')
            .map((value) => normalizeUrl(value, pageUrl))
            .filter((value): value is string => Boolean(value)),
        );
  const fallbackOgImage = rule.id === 'repuestosavenida'
    ? validRepuestosAvenidaImageUrl(firstAttributeValue(root, ['meta[property="og:image"]'], 'content'), pageUrl)
    : isFenicioRule(rule)
      ? validFenicioProductImageUrl(firstAttributeValue(root, ['meta[property="og:image"]'], 'content'), pageUrl)
      : normalizeUrl(firstAttributeValue(root, ['meta[property="og:image"]'], 'content'), pageUrl);


  return {
    productName: title,
    price: normalizePriceValue(rawPrice),
    currency: inferCurrency(rawPrice),
    brand: extractBrandFromText(brandText),
    sku: cleanText(skuText?.match(/(?:sku|c[oó]d(?:igo)?\.?)\s*[:#-]?\s*([\w.-]+)/i)?.[1]),
    description: firstNonEmpty(selectText(root, rule.detailSelectors?.description ?? ['meta[name="description"]', 'main p'])),
    imageUrl:
      imageUrls[0]
      ?? (rule.id === 'grfrenos'
        ? undefined
        : fallbackOgImage),
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
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

function extractFeyviDetailProduct(root: HTMLElement, pageUrl: string, provider: ProviderName, rule: DomainRule): ProductRecord | undefined {
  const title = firstNonEmpty(selectText(root, rule.detailSelectors?.title ?? ['h1']));
  if (!title) {
    return undefined;
  }

  const rawPrice = firstNonEmpty(selectText(root, [...(rule.detailSelectors?.price ?? []), ...GENERIC_PRICE_SELECTORS]));
  const pageText = cleanText(firstElementText(root, ['body']) ?? root.text) ?? '';
  if (/(404|page not found|not found|pagina no encontrada|p[aá]gina no encontrada|no se ha podido encontrar)/i.test(pageText)) {
    return undefined;
  }

  const availabilityText = collectAvailabilityText(root);
  const availability = resolveDetailAvailability(root, availabilityText, rule);
  const compatibility = extractCompatibilityFromRoot(root);
  const imageUrls = extractFeyviImages(root, pageUrl);
  const brand = extractFeyviBrand(root);
  const skuText = firstNonEmpty([
    firstAttributeValue(root, ['meta[itemprop="sku"]'], 'content'),
    ...selectText(root, rule.detailSelectors?.sku ?? []),
  ]);

  return {
    productName: title,
    price: normalizePriceValue(rawPrice),
    currency: inferCurrency(rawPrice),
    brand,
    sku: cleanText(skuText?.match(/(?:sku|c[oó]d(?:igo)?\.?)\s*[:#-]?\s*([\w.-]+)/i)?.[1] ?? skuText),
    description: firstNonEmpty(selectText(root, rule.detailSelectors?.description ?? ['meta[name="description"]', 'main p'])),
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    ...compatibility,
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

function extractFeyviBrand(root: HTMLElement): string | undefined {
  const jsonLdBrand = firstNonEmpty(extractJsonLdProducts(root, 'https://www.feyvi.com.uy/', 'domain').map((product) => product.brand));
  if (jsonLdBrand) {
    return jsonLdBrand;
  }

  for (const feature of root.querySelectorAll('.ty-product-feature, .ty-control-group')) {
    const label = normalizeCompatibilityLabel(feature.querySelector('.ty-product-feature__label, .ty-control-group__label, .abt-yt-feature-name')?.text);
    if (label !== 'fabricante') {
      continue;
    }

    const clone = feature.clone() as HTMLElement;
    clone.querySelector('.ty-product-feature__label, .ty-control-group__label, .abt-yt-feature-name')?.remove();
    clone.querySelectorAll('input, label').forEach((element) => element.remove());
    const value = cleanText(clone.text);
    if (value) {
      return value;
    }
  }

  return firstAttributeValue(root, ['meta[itemprop="brand"]'], 'content');
}

function extractFeyviImages(root: HTMLElement, pageUrl: string): string[] {
  const primary = uniqueStrings([
    ...attributeValues(root, ['.ty-product-img .cm-image-previewer[href]', '[id^="product_images_"] .cm-image-previewer[href]'], 'href'),
    ...queryAll(root, '.ty-product-img img, [id^="product_images_"] img, .ty-grid-list__image .abt-single-image img, .ty-grid-list__image img').flatMap((element) => imageCandidatesFromElement(element, pageUrl)),
  ])
    .map((value) => validFeyviImageUrl(value, pageUrl))
    .filter((value): value is string => Boolean(value));

  const jsonLdImages = extractJsonLdImageUrls(root, pageUrl)
    .map((value) => validFeyviImageUrl(value, pageUrl))
    .filter((value): value is string => Boolean(value));

  const ogImages = attributeValues(root, ['meta[property="og:image"], meta[name="twitter:image"]'], 'content')
    .map((value) => validFeyviImageUrl(value, pageUrl))
    .filter((value): value is string => Boolean(value));

  return uniqueStrings([...primary, ...jsonLdImages, ...ogImages]);
}

function validFeyviImageUrl(value: string | undefined, pageUrl: string): string | undefined {
  const url = normalizeUrl(value, pageUrl);
  if (!url) {
    return undefined;
  }

  const lowered = url.toLowerCase();
  if (!/\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url)) {
    return undefined;
  }

  if (/logo|favicon|placeholder|no-image|sin-imagen|loader|sprite|banner|promo|medios?[-_]?pago|visa|mastercard|whatsapp|facebook|instagram|abt__yt_mwi__icon|design\/themes|\/icons?\//i.test(lowered)) {
    return undefined;
  }

  if (!/\/images\/(?:thumbnails\/\d+\/\d+\/)?detailed\//i.test(lowered)) {
    return undefined;
  }

  return url;
}

function extractRepuestosAvenidaImages(root: HTMLElement, pageUrl: string): string[] {
  const urls: string[] = [];

  for (const selector of [
    'article.storefront-product .storefront-product-image[data-role="main-image"]',
    '.storefront-product-stage img[data-role="main-image"]',
    '.storefront-product-media .storefront-product-image',
  ]) {
    queryAll(root, selector).forEach((element) => {
      urls.push(...imageCandidatesFromElement(element, pageUrl));
    });
  }

  queryAll(root, 'article.storefront-product[data-product-gallery], article.storefront-product[data-gallery]').forEach((element) => {
    for (const attribute of ['data-product-gallery', 'data-gallery']) {
      const raw = element.getAttribute(attribute);
      if (!raw) {
        continue;
      }

      parseRepuestosAvenidaGalleryAttribute(raw)
        .map((value) => validRepuestosAvenidaImageUrl(value, pageUrl))
        .filter((value): value is string => Boolean(value))
        .forEach((value) => urls.push(value));
    }
  });

  queryAll(root, '.storefront-product-gallery [data-thumb-url]').forEach((element) => {
    const value = element.getAttribute('data-thumb-url');
    if (value) {
      urls.push(value);
    }
  });

  const jsonLdImages = extractJsonLdImageUrls(root, pageUrl)
    .map((value) => validRepuestosAvenidaImageUrl(value, pageUrl))
    .filter((value): value is string => Boolean(value));

  return uniqueStrings([
    ...urls.map((value) => validRepuestosAvenidaImageUrl(value, pageUrl)).filter((value): value is string => Boolean(value)),
    ...jsonLdImages,
  ]);
}

function isFenicioRule(rule: DomainRule): boolean {
  return rule.id === 'cymaco' || rule.id === 'familcar';
}

function extractFenicioDetailImages(root: HTMLElement, pageUrl: string): string[] {
  const urls: string[] = [
    firstAttributeValue(root, ['meta[property="og:image"]'], 'content'),
    firstAttributeValue(root, ['meta[name="twitter:image"]'], 'content'),
  ].filter((value): value is string => Boolean(value));

  queryAll(root, 'input.json[value]').forEach((input) => {
    urls.push(...parseFenicioJsonImageUrls(input.getAttribute('value')));
  });

  for (const selector of [
    '#ficha img',
    '#wrapperFicha img',
    '.ficha img',
    '.fichaProducto img',
    '.galeria img',
    '.imagenes img',
    '.swiper-slide img',
    'main img',
  ]) {
    queryAll(root, selector).forEach((element) => {
      urls.push(...imageCandidatesFromElement(element, pageUrl));
    });
  }

  return uniqueStrings(
    urls
      .map((url) => validFenicioProductImageUrl(url, pageUrl))
      .filter((url): url is string => Boolean(url)),
  );
}

function parseFenicioJsonImageUrls(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeHtmlAttribute(raw)) as unknown;
    const urls: string[] = [];
    collectFenicioJsonImageUrls(parsed, urls);
    return urls;
  } catch {
    return [];
  }
}

function collectFenicioJsonImageUrls(value: unknown, urls: string[]): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectFenicioJsonImageUrls(item, urls));
    return;
  }

  const record = value as Record<string, unknown>;
  const image = record.img;
  if (typeof image === 'string') {
    urls.push(image);
  } else if (image && typeof image === 'object') {
    const imageRecord = image as Record<string, unknown>;
    for (const key of ['u', 'url', 'src', 'original']) {
      if (typeof imageRecord[key] === 'string') {
        urls.push(imageRecord[key]);
      }
    }
  }

  Object.values(record).forEach((child) => collectFenicioJsonImageUrls(child, urls));
}

function validFenicioProductImageUrl(value: string | undefined, pageUrl: string): string | undefined {
  const url = normalizeUrl(value, pageUrl);
  if (!url) {
    return undefined;
  }

  const lowered = url.toLowerCase();
  if (new RegExp('(^|[/_.-])logo([/_.-]|$)', 'i').test(lowered)
    || /logomarca|favicon|brand|branding|banner|placeholder|no-image|sin-imagen|whatsapp|facebook|instagram|iconos?|cocarda|grupoproductos|descuentos|medios?[-_]?pago|creditoydebito|visa|mastercard|assets\/commerce/i.test(lowered)) {
    return undefined;
  }
  if (!/\.(?:avif|gif|jpe?g|png|webp|svg)(?:[?#]|$)/i.test(url)) {
    return undefined;
  }

  return url;
}

function extractDiegoRadiadoresImages(root: HTMLElement, pageUrl: string): string[] {
  const urls: string[] = [];

  for (const selector of [
    'img.wp-post-image',
    'img[data-large_image]',
    '.woocommerce-product-gallery img',
  ]) {
    queryAll(root, selector).forEach((element) => {
      urls.push(...imageCandidatesFromElement(element, pageUrl));
    });
  }

  const ogImage = normalizeUrl(
    firstAttributeValue(root, ['meta[property="og:image"]'], 'content'),
    pageUrl,
  );

  if (ogImage) {
    urls.push(ogImage);
  }

  return uniqueStrings(urls);
}

function imageCandidatesFromElement(element: HTMLElement, pageUrl: string): string[] {
  return [
    element.getAttribute('data-large_image'),
    element.getAttribute('data-zoom-image'),
    element.getAttribute('data-lazy-src'),
    element.getAttribute('data-src'),
    element.getAttribute('src'),
    largestSrcsetCandidate(element.getAttribute('srcset')),
  ]
    .map((value) => normalizeUrl(value, pageUrl))
    .filter((value): value is string => Boolean(value));
}

function largestSrcsetCandidate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split(',')
    .map((part) => {
      const [url, descriptor] = part.trim().split(/\s+/, 2);
      const width = Number(descriptor?.replace(/[^\d.]/g, '') ?? 0);
      return { url, width: Number.isFinite(width) ? width : 0 };
    })
    .filter((candidate) => Boolean(candidate.url))
    .sort((a, b) => b.width - a.width)[0]?.url;
}

function parseRepuestosAvenidaGalleryAttribute(raw: string): string[] {
  try {
    const parsed = JSON.parse(decodeHtmlAttribute(raw)) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.flatMap((item) => {
      if (typeof item === 'string') {
        return [item];
      }
      if (!item || typeof item !== 'object') {
        return [];
      }
      const record = item as Record<string, unknown>;
      return [asString(record.url), asString(record.src), asString(record.full), asString(record.image)]
        .filter((value): value is string => Boolean(value));
    });
  } catch {
    return [];
  }
}

function extractJsonLdImageUrls(root: HTMLElement, pageUrl: string): string[] {
  const urls: string[] = [];

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
        const images = Array.isArray(node.image) ? node.image : [node.image];
        images
          .map((value) => normalizeUrl(asString(value), pageUrl))
          .filter((value): value is string => Boolean(value))
          .forEach((value) => urls.push(value));
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  });

  return urls;
}

function validRepuestosAvenidaImageUrl(value: string | undefined, pageUrl: string): string | undefined {
  const url = normalizeUrl(value, pageUrl);
  if (!url) {
    return undefined;
  }

  const comparable = url.toLowerCase();
  if (/(?:logo|favicon|brand|branding|placeholder|no-image|sin-imagen|header|footer|whatsapp)/i.test(comparable)) {
    return undefined;
  }
  if (!/\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url)) {
    return undefined;
  }

  return canonicalizeRepuestosAvenidaImageUrl(url);
}

function canonicalizeRepuestosAvenidaImageUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_|v$|ver$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&amp;/g, '&');
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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

function normalizeGrFrenosLabel(value?: string): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return undefined;
  }

  const ascii = cleaned
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!ascii) {
    return undefined;
  }

  return ascii
    .split(' ')
    .map((token) => {
      if (/^[A-Z0-9]{2,3}$/.test(token)) {
        return token;
      }

      if (token.length === 1) {
        return token.toUpperCase();
      }

      return token.slice(0, 1).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join(' ');
}

function parseResultCount(value: string): number | undefined {
  const match = value.match(/(\d[\d.,]*)\s+resultados?/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1].replace(/[.,]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
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
