import { existsSync } from 'node:fs';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { chromium, type Browser, type Page } from 'playwright';
import { ProductRecord, ProviderResult, ScrapingOperationPayload, ScrapingProvider, ScrapingTask } from '../interfaces/scraping.types';

type DiscoveredPage = {
  url: string;
  depth: number;
  title?: string;
  links: string[];
  products: ProductRecord[];
};

@Injectable()
export class PlaywrightProvider implements ScrapingProvider {
  readonly name = 'playwright' as const;
  private readonly logger = new Logger(PlaywrightProvider.name);

  async run(task: ScrapingTask, payload: ScrapingOperationPayload): Promise<ProviderResult> {
    const sourceUrl = typeof payload.url === 'string' ? payload.url : undefined;
    const browser = await this.launchBrowser();

    try {
      if (task === 'crawl') {
        const raw = await this.crawl(browser, payload);
        return {
          provider: this.name,
          task,
          requestedAt: new Date().toISOString(),
          sourceUrl,
          raw,
          normalizedProducts: raw.pages.flatMap((page) => page.products),
        };
      }

      const raw = await this.extract(browser, payload);
      return {
        provider: this.name,
        task,
        requestedAt: new Date().toISOString(),
        sourceUrl,
        raw,
        normalizedProducts: raw.products,
      };
    } finally {
      await browser.close();
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const executablePath = resolveBrowserExecutablePath();

    try {
      return await chromium.launch({
        headless: true,
        executablePath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new InternalServerErrorException(
        `No se pudo iniciar Playwright Chromium. Verifica el navegador instalado o corre \`npx playwright install chromium\`. Detalle: ${message}`,
      );
    }
  }

  private async crawl(browser: Browser, payload: ScrapingOperationPayload) {
    const seedUrl = asString(payload.url);
    if (!seedUrl) {
      return { seedUrl: undefined, pages: [], discoveredUrls: [] };
    }

    const limit = clampNumber(payload.limit, 1, 5000, 30);
    const includePaths = asStringArray(payload.includePaths);
    const excludePaths = asStringArray(payload.excludePaths);
    const sitemapUrls = await discoverUrlsFromSitemaps(seedUrl, limit, includePaths, excludePaths);

    if (sitemapUrls.length > 0) {
      return {
        seedUrl,
        pages: [],
        discoveredUrls: sitemapUrls,
        discoveryMethod: 'sitemap',
      };
    }

    const queue: Array<{ url: string; depth: number }> = [{ url: seedUrl, depth: 0 }];
    const visited = new Set<string>();
    const pages: DiscoveredPage[] = [];
    const discoveredUrls = new Set<string>();
    const origin = safeOrigin(seedUrl);

    while (queue.length > 0 && pages.length < limit) {
      const current = queue.shift();
      if (!current || visited.has(current.url)) {
        continue;
      }

      visited.add(current.url);
      const pageData = await this.visitPage(browser, current.url, payload);
      const filteredLinks = prioritizeLinks(pageData.links, origin, includePaths, excludePaths).slice(0, limit);
      filteredLinks.forEach((link) => discoveredUrls.add(link));

      pages.push({
        url: current.url,
        depth: current.depth,
        title: pageData.title,
        links: filteredLinks,
        products: pageData.products,
      });

      if (current.depth >= 2) {
        continue;
      }

      for (const link of filteredLinks) {
        if (queue.length + pages.length >= limit) {
          break;
        }

        if (!visited.has(link) && shouldQueueForCrawl(link)) {
          queue.push({ url: link, depth: current.depth + 1 });
        }
      }
    }

    return {
      seedUrl,
      pages,
      discoveredUrls: Array.from(discoveredUrls).slice(0, limit),
      discoveryMethod: 'playwright-crawl',
    };
  }

  private async extract(browser: Browser, payload: ScrapingOperationPayload) {
    const requestedUrls = uniqueStrings([
      ...asStringArray(payload.urls),
      ...(asString(payload.url) ? [asString(payload.url)!] : []),
    ]);
    const maxItems = clampNumber(payload.maxItems, 1, 20000, 150);
    const pages = [];
    const products: ProductRecord[] = [];

    for (const url of requestedUrls) {
      if (products.length >= maxItems) {
        break;
      }

      let pageData: { title: string; links: string[]; products: ProductRecord[] } | undefined;

      try {
        pageData = await this.visitPage(browser, url, payload);
      } catch (error) {
        this.logger.warn(`No se pudo extraer ${url}: ${formatError(error)}`);
        continue;
      }

      pages.push({
        url,
        title: pageData.title,
        productCount: pageData.products.length,
      });

      for (const product of pageData.products) {
        if (products.length >= maxItems) {
          break;
        }

        products.push(product);
      }
    }

    return {
      urls: requestedUrls,
      pages,
      products: dedupeProducts(products).slice(0, maxItems),
    };
  }

  private async visitPage(browser: Browser, url: string, payload: ScrapingOperationPayload) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    try {
      const page = await context.newPage();
      const waitFor = clampNumber(payload.waitFor, 0, 15000, 1500);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
      if (waitFor > 0 && !page.isClosed()) {
        await page.waitForTimeout(waitFor);
      }

      return {
        title: await page.title(),
        links: await extractLinks(page, url),
        products: await extractProducts(page, url, this.name),
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function extractLinks(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate((base) => {
    const normalize = (value: string) => {
      try {
        return new URL(value, base).toString();
      } catch {
        return undefined;
      }
    };

    return Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => normalize(anchor.getAttribute('href') ?? ''))
      .filter((value): value is string => Boolean(value));
  }, baseUrl);

  return uniqueStrings(links);
}

async function extractProducts(page: Page, pageUrl: string, provider: 'playwright'): Promise<ProductRecord[]> {
  const rawProducts = await page.evaluate((url) => {
    const priceRegex = /(US\$|\$|UYU|USD)\s*[\d.,]+|[\d]{1,3}(?:[.,][\d]{3})*(?:[.,][\d]{2})\s*(?:US\$|\$|UYU|USD)?/i;
    const text = (value?: string | null) => value?.replace(/\s+/g, ' ').trim() ?? '';
    const absoluteUrl = (value?: string | null) => {
      if (!value) return undefined;
      try {
        return new URL(value, url).toString();
      } catch {
        return undefined;
      }
    };
    const ignoredNameRegex = /ver m[aá]s|home|men[uú]|precio|buscar|vista r[aá]pida|agregar al carrito/i;
    const normalizeName = (value?: string | null) =>
      text(value)
        .replace(/vista r[aá]pida/gi, '')
        .replace(/agregar al carrito/gi, '')
        .replace(/precio(?: de oferta)?[\s:$]*.*$/gi, '')
        .trim();
    const pickImage = (root: ParentNode) => {
      const image = root.querySelector?.('img');
      const source = image?.getAttribute('src') || image?.getAttribute('data-src') || image?.getAttribute('srcset')?.split(',')[0]?.trim().split(' ')[0];
      return absoluteUrl(source);
    };
    const pickAvailability = (root: ParentNode) => {
      const content = text((root as Element).textContent).toLowerCase();
      if (!content) return '';
      if (/agotado|sin stock|out of stock/.test(content)) return 'out_of_stock';
      if (/en stock|disponible|add to cart|agregar al carrito/.test(content)) return 'in_stock';
      return '';
    };
    const pickPrice = (root: ParentNode) => {
      const nodes = Array.from(root.querySelectorAll?.('*') ?? []).map((node) => text(node.textContent)).filter(Boolean);
      for (const value of nodes) {
        const match = value.match(priceRegex);
        if (match) return match[0];
      }
      return text((root as Element).textContent).match(priceRegex)?.[0] ?? '';
    };
    const pickName = (root: Element) => {
      for (const selector of ['h1', 'h2', 'h3', 'h4', '[class*="title"]', '[class*="name"]', 'a[href]']) {
        const value = normalizeName(root.querySelector(selector)?.textContent);
        if (value && value.length >= 4 && !priceRegex.test(value) && !ignoredNameRegex.test(value)) return value;
      }
      return '';
    };
    const findContainer = (element: Element) => {
      let current: Element | null = element;
      while (current && current !== document.body) {
        const content = text(current.textContent);
        if (content && content.length <= 800 && priceRegex.test(content)) return current;
        current = current.parentElement;
      }
      return element.parentElement ?? element;
    };
    const collectStructuredData = () => {
      const records: Array<Record<string, string>> = [];
      for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try {
          const parsed = JSON.parse(script.textContent ?? 'null');
          const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
          while (stack.length > 0) {
            const current = stack.pop();
            if (!current || typeof current !== 'object') continue;
            if (Array.isArray(current)) {
              stack.push(...current);
              continue;
            }
            if (current['@type'] === 'Product') {
              const offer = Array.isArray(current.offers) ? current.offers[0] : current.offers;
              records.push({
                productName: text(current.name),
                price: text(offer?.price ?? current.price),
                currency: text(offer?.priceCurrency),
                sku: text(current.sku),
                brand: text(current.brand?.name ?? current.brand),
                availability: text(offer?.availability),
                sourceUrl: absoluteUrl(current.url) ?? url,
                imageUrl: absoluteUrl(Array.isArray(current.image) ? current.image[0] : current.image) ?? '',
              });
            }
            Object.values(current).forEach((value) => {
              if (value && typeof value === 'object') stack.push(value);
            });
          }
        } catch {
          // Ignore malformed JSON-LD.
        }
      }
      return records;
    };
    const isDetailPage = /\/product\/|\/producto\/|\/catalogo\/[^/]+\/[^/]+/i.test(new URL(url).pathname);
    const linkedCards = Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => {
        const href = anchor.getAttribute('href') ?? '';
        if (!/product-page|\/product\/|\/producto\/|\/catalogo\//i.test(href)) return undefined;
        const container = findContainer(anchor);
        const productName = normalizeName(anchor.textContent) || pickName(container);
        const price = pickPrice(container);
        if (!productName || !price || ignoredNameRegex.test(productName)) return undefined;
        const compatibleBrands = Array.from(
          new Set((text(container.textContent).match(/(?:toyota|nissan|fiat|ford|volkswagen|vw|renault|peugeot|citroen|hyundai|kia|chevrolet|suzuki|mazda|mitsubishi|chery|geely|byd)/gi) ?? []).map((value) => value.trim())),
        );
        return {
          productName,
          price,
          sourceUrl: absoluteUrl(href),
          imageUrl: pickImage(container),
          availability: pickAvailability(container),
          stock: pickAvailability(container) === 'out_of_stock' ? '0' : undefined,
          compatibleBrands: compatibleBrands.join('|'),
        };
      })
      .filter(Boolean);
    const bodyText = text(document.body.textContent);
    const attributes = Object.fromEntries(
      Array.from(document.querySelectorAll('table tr, [class*="attributes"] tr'))
        .map((row) => {
          const cells = Array.from(row.querySelectorAll('th, td')).map((cell) => text(cell.textContent)).filter(Boolean);
          return cells.length >= 2 ? [cells[0], cells.slice(1).join(' / ')] : undefined;
        })
        .filter((entry): entry is [string, string] => Boolean(entry)),
    );
    const compatibleBrands = Array.from(
      new Set((bodyText.match(/(?:toyota|nissan|fiat|ford|volkswagen|vw|renault|peugeot|citroen|hyundai|kia|chevrolet|suzuki|mazda|mitsubishi|chery|geely|byd)/gi) ?? []).map((value) => value.trim())),
    );
    const shippingInfo = bodyText
      .split(/(?<=[.!?])\s+/)
      .filter((line) => /env[ií]o|retiro|pickup|delivery|despacho/i.test(line))
      .slice(0, 5);
    const pageHeading = normalizeName(document.querySelector('h1')?.textContent);
    const pagePrice = bodyText.match(priceRegex)?.[0] ?? '';
    const detailedRecord =
      pageHeading && pagePrice
        ? [
            {
              productName: pageHeading,
              price: pagePrice,
              sourceUrl: url,
              imageUrl:
                absoluteUrl(document.querySelector('meta[property="og:image"]')?.getAttribute('content')) ||
                pickImage(document.querySelector('main') ?? document.body),
              category: text(document.querySelector('[class*="breadcrumb"] li:last-child, [class*="breadcrumb"] a:last-child')?.textContent),
              description:
                text(document.querySelector('meta[name="description"]')?.getAttribute('content')) ||
                text(document.querySelector('[class*="description"], .woocommerce-product-details__short-description, article, main')?.textContent),
              compatibleBrands: compatibleBrands.join('|'),
              shippingInfo: shippingInfo.join('|'),
              attributes: Object.keys(attributes).length ? JSON.stringify(attributes) : undefined,
              availability: pickAvailability(document.body),
              stock: pickAvailability(document.body) === 'out_of_stock' ? '0' : undefined,
            },
          ]
        : [];
    return isDetailPage ? [...collectStructuredData(), ...detailedRecord] : [...collectStructuredData(), ...linkedCards, ...detailedRecord];
  }, pageUrl);

  return dedupeProducts(
    rawProducts
      .map((product) => normalizeExtractedProduct(product as Record<string, unknown>, pageUrl, provider))
      .filter((product): product is ProductRecord => Boolean(product)),
  );
}

function normalizeExtractedProduct(
  product: Record<string, unknown>,
  pageUrl: string,
  provider: 'playwright',
): ProductRecord | undefined {
  const productName = cleanText(asString(product.productName));
  const rawPrice = cleanText(asString(product.price));

  if (!productName || !rawPrice) {
    return undefined;
  }

  return {
    productName,
    price: normalizePrice(rawPrice),
    currency: inferCurrency(rawPrice, asString(product.currency)),
    brand: cleanText(asString(product.brand)),
    sku: cleanText(asString(product.sku)),
    category: cleanText(asString(product.category)),
    description: cleanText(asString(product.description)),
    availability: cleanText(asString(product.availability)),
    stock: cleanText(asString(product.stock)),
    sourceUrl: cleanText(asString(product.sourceUrl)) ?? pageUrl,
    imageUrl: cleanText(asString(product.imageUrl)),
    compatibleBrands: asPipeArray(product.compatibleBrands),
    compatibleVehicles: asPipeArray(product.compatibleVehicles),
    shippingInfo: asPipeArray(product.shippingInfo),
    attributes: parseAttributes(product.attributes),
    extractedAt: new Date().toISOString(),
    provider,
  };
}

function dedupeProducts(products: ProductRecord[]): ProductRecord[] {
  const seen = new Map<string, ProductRecord>();

  for (const product of products) {
    const key = [product.sourceUrl, product.sku, product.productName]
      .map((value) => cleanText(value)?.toLowerCase())
      .filter(Boolean)
      .join('|');

    if (!key) {
      continue;
    }

    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, product);
      continue;
    }

    seen.set(key, {
      ...previous,
      ...product,
      stock: product.stock ?? previous.stock,
      availability: product.availability ?? previous.availability,
      imageUrl: product.imageUrl ?? previous.imageUrl,
      shippingInfo: product.shippingInfo?.length ? product.shippingInfo : previous.shippingInfo,
      compatibleBrands: product.compatibleBrands?.length ? product.compatibleBrands : previous.compatibleBrands,
      compatibleVehicles: product.compatibleVehicles?.length ? product.compatibleVehicles : previous.compatibleVehicles,
      attributes: product.attributes && Object.keys(product.attributes).length ? product.attributes : previous.attributes,
    });
  }

  return Array.from(seen.values());
}

function prioritizeLinks(urls: string[], origin?: string, includePaths: string[] = [], excludePaths: string[] = []): string[] {
  return urls
    .filter((url) => {
      if (origin && safeOrigin(url) !== origin) {
        return false;
      }

      const pathname = safePathname(url);
      if (!pathname) {
        return false;
      }

      if (excludePaths.some((path) => pathname.includes(path))) {
        return false;
      }

      if (includePaths.length > 0) {
        return includePaths.some((path) => pathname.includes(path));
      }

      if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|css|js)(\?|#|$)/i.test(url)) {
        return false;
      }

      return /producto|product|product-page|catalogo|shop|categoria|category|catalog|ofertas|outlet|productos/i.test(pathname);
    })
    .sort((left, right) => scoreUrl(right) - scoreUrl(left));
}

function shouldQueueForCrawl(url: string): boolean {
  return !/product-page|\/product\/|\/producto\/|\/catalogo\/[^/]+\/[^/]+/i.test(url);
}

function scoreUrl(url: string): number {
  let score = 0;
  if (/product-page|\/product\/|\/producto\/|\/catalogo\/[^/]+\/[^/]+/i.test(url)) score += 7;
  if (/product-category|\/shop\/|\/productos\/|\/catalogo\//i.test(url)) score += 4;
  if (/ofertas|outlet|destacados/i.test(url)) score += 2;
  return score;
}

async function discoverUrlsFromSitemaps(
  seedUrl: string,
  limit: number,
  includePaths: string[],
  excludePaths: string[],
): Promise<string[]> {
  const candidates = await collectSitemapCandidates(seedUrl);
  const visited = new Set<string>();
  const discovered = new Set<string>();
  const origin = safeOrigin(seedUrl);

  for (const sitemapUrl of candidates) {
    await walkSitemap(sitemapUrl, visited, async (url) => {
      if (origin && safeOrigin(url) !== origin) {
        return;
      }
      discovered.add(url);
    });
  }

  return prioritizeLinks(Array.from(discovered), origin, includePaths, excludePaths).slice(0, limit);
}

async function collectSitemapCandidates(seedUrl: string): Promise<string[]> {
  const candidates = new Set<string>();
  const base = new URL(seedUrl);
  const root = `${base.protocol}//${base.host}`;

  [
    `${root}/robots.txt`,
    `${root}/sitemap.xml`,
    `${root}/sitemap_index.xml`,
    `${root}/product-sitemap.xml`,
    `${root}/wp-sitemap.xml`,
  ].forEach((value) => candidates.add(value));

  try {
    const response = await fetch(`${root}/robots.txt`);
    if (response.ok) {
      const text = await response.text();
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^sitemap:\s*(.+)$/i);
        if (match) {
          candidates.add(match[1].trim());
        }
      }
    }
  } catch {
    // Ignore robots fetch errors.
  }

  return Array.from(candidates);
}

async function walkSitemap(url: string, visited: Set<string>, onUrl: (url: string) => Promise<void>): Promise<void> {
  if (visited.has(url)) {
    return;
  }

  visited.add(url);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (!contentType.includes('xml') && !text.includes('<urlset') && !text.includes('<sitemapindex')) {
      return;
    }

    const locations = Array.from(text.matchAll(/<loc>(.*?)<\/loc>/gsi)).map((match) => decodeXmlEntities(match[1].trim()));

    if (text.includes('<sitemapindex')) {
      for (const nestedUrl of locations) {
        await walkSitemap(nestedUrl, visited, onUrl);
      }
      return;
    }

    for (const location of locations) {
      await onUrl(location);
    }
  } catch {
    // Ignore invalid sitemap endpoints.
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function resolveBrowserExecutablePath(): string | undefined {
  const configured = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (configured) {
    return configured;
  }

  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((item): item is string => Boolean(item)) : [];
}

function asPipeArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map(asString).filter((item): item is string => Boolean(item));
  }

  if (typeof value === 'string' && value.trim()) {
    return value
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return undefined;
}

function parseAttributes(value: unknown): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, asString(entry)])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed)
          .map(([key, entry]) => [key, asString(entry)])
          .filter((entry): entry is [string, string] => Boolean(entry[1])),
      );
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function safePathname(url: string): string | undefined {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
}

function cleanText(value?: string): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

function normalizePrice(value: string): string {
  return value.replace(/(US\$|\$|UYU|USD)\s*/gi, '').trim();
}

function inferCurrency(rawPrice: string, explicitCurrency?: string): string | undefined {
  const currency = explicitCurrency?.toUpperCase();
  if (currency) {
    return currency;
  }

  if (/US\$/i.test(rawPrice) || /USD/i.test(rawPrice)) {
    return 'USD';
  }

  if (/\$/i.test(rawPrice) || /UYU/i.test(rawPrice)) {
    return 'UYU';
  }

  return undefined;
}
