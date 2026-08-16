import type { Page } from 'playwright';
import type { ProductRecord } from '../interfaces/scraping.types';
import {
  hasVisibleYokomitsuCaptchaChallenge,
  type YokomitsuCaptchaSignal,
  YOKOMITSU_BASE_URL,
  YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS,
} from './yokomitsu';

const CATALOG_LINK_PATTERN = /catalog|catalogo|producto|productos|repuesto|repuestos|stock|precio|marca|modelo|buscar|busqueda/i;
const CAPTCHA_SELECTOR = [
  'iframe',
  'textarea',
  'input',
  'button',
  'div',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  '[src*="captcha" i]',
].join(', ');
const PRODUCT_CARD_SELECTOR = '[data-product], [data-codprod], .product, .producto, .card, tr';
const PRODUCT_NAME_SELECTOR = 'h1,h2,h3,h4,[class*="name"],[class*="nombre"],[class*="descripcion"],[class*="producto"]';
const PRODUCT_SKU_SELECTOR = '[class*="sku"],[class*="codigo"],[class*="code"]';

export async function detectYokomitsuCaptcha(page: Page): Promise<boolean> {
  const candidates = page.locator(CAPTCHA_SELECTOR);
  const count = Math.min(await candidates.count(), 100);
  const signals: YokomitsuCaptchaSignal[] = [];

  for (let index = 0; index < count; index += 1) {
    const element = candidates.nth(index);
    signals.push({
      tagName: 'div',
      id: await optionalAttribute(element, 'id'),
      className: await optionalAttribute(element, 'class'),
      title: await optionalAttribute(element, 'title'),
      src: await optionalAttribute(element, 'src'),
      text: truncate(await element.textContent().catch(() => undefined), 120),
      visible: await element.isVisible().catch(() => false),
    });
  }

  return hasVisibleYokomitsuCaptchaChallenge(signals);
}

export async function collectYokomitsuCatalogLinks(page: Page): Promise<string[]> {
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 200);
  const urls = new Set<string>();

  for (let index = 0; index < count && urls.size < 5; index += 1) {
    const anchor = anchors.nth(index);
    const href = await anchor.getAttribute('href').catch(() => undefined);
    const text = await anchor.textContent().catch(() => undefined);
    const absoluteUrl = normalizeUrl(href, page.url());
    if (absoluteUrl && CATALOG_LINK_PATTERN.test(`${absoluteUrl} ${text ?? ''}`)) {
      urls.add(absoluteUrl);
    }
  }

  return Array.from(urls);
}

export async function extractYokomitsuProductsFromDom(page: Page, baseUrl = YOKOMITSU_BASE_URL): Promise<ProductRecord[]> {
  const cards = page.locator(PRODUCT_CARD_SELECTOR);
  const count = Math.min(await cards.count(), 20);
  const products: ProductRecord[] = [];

  for (let index = 0; index < count && products.length < YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS; index += 1) {
    const card = cards.nth(index);
    const text = clean(await card.textContent().catch(() => undefined));
    const anchor = card.locator('a[href]').first();
    const image = card.locator('img[src], img[data-src]').first();
    const nameNode = card.locator(PRODUCT_NAME_SELECTOR).first();
    const skuNode = card.locator(PRODUCT_SKU_SELECTOR).first();
    const anchorHref = await firstAttribute(anchor, 'href');
    const imageSrc = await firstAttribute(image, 'src') ?? await firstAttribute(image, 'data-src');
    const name = await firstText(nameNode) ?? await firstText(anchor);
    const sku = clean(await card.getAttribute('data-codprod').catch(() => undefined)) ?? await firstText(skuNode);
    const price = text?.match(/(?:US\$|\$U|\$|UYU|USD)?\s*\d[\d.,]*/i)?.[0];

    if (!name && !sku) continue;

    products.push({
      productName: name,
      sourceUrl: normalizeUrl(anchorHref, baseUrl) ?? page.url(),
      sku,
      price,
      imageUrl: normalizeUrl(imageSrc, baseUrl),
      description: text && text.length <= 500 ? text : undefined,
      provider: 'Yokomitsu',
      extractedAt: new Date().toISOString(),
    });
  }

  return products;
}

export async function detectYokomitsuTwoFactor(page: Page): Promise<boolean> {
  const text = await page.locator('body').textContent().catch(() => '');
  return /2fa|c[o\u00f3]digo de verificaci[o\u00f3]n|verificaci[o\u00f3]n|otp|token/i.test(text ?? '');
}

export async function inspectYokomitsuStorage(page: Page): Promise<{ localStorageKeys: number; hasJwt: boolean; hasBearer: boolean; hasRefreshToken: boolean }> {
  return page.evaluate(`(() => {
    const entries = Object.keys(localStorage).map((key) => ({ key, value: localStorage.getItem(key) || '' }));
    const text = entries.map((entry) => entry.key + ' ' + entry.value).join(' ');
    return {
      localStorageKeys: entries.length,
      hasJwt: /eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/.test(text),
      hasBearer: /bearer/i.test(text),
      hasRefreshToken: /refresh/i.test(text),
    };
  })()`);
}

async function optionalAttribute(locator: ReturnType<Page['locator']>, name: string): Promise<string | undefined> {
  return clean(await locator.getAttribute(name).catch(() => undefined));
}

async function firstAttribute(locator: ReturnType<Page['locator']>, name: string): Promise<string | undefined> {
  if (await locator.count().catch(() => 0) === 0) return undefined;
  return optionalAttribute(locator, name);
}

async function firstText(locator: ReturnType<Page['locator']>): Promise<string | undefined> {
  if (await locator.count().catch(() => 0) === 0) return undefined;
  return clean(await locator.textContent().catch(() => undefined));
}

function clean(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function truncate(value: string | null | undefined, length: number): string | undefined {
  return clean(value)?.slice(0, length);
}

function normalizeUrl(value: string | null | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return /^https?:$/i.test(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
