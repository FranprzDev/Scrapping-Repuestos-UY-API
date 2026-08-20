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
const TWO_FACTOR_FIELD_PATTERN = /\b(2fa|mfa|otp|one[-_\s]?time[-_\s]?code|verification[-_\s]?code|c[oó]digo[-_\s]*(?:de[-_\s]*)?verificaci[oó]n|verificaci[oó]n[-_\s]*c[oó]digo)\b/i;
const TWO_FACTOR_FORM_PATTERN = /\b(2fa|mfa|otp|two[-_\s]?factor|verificaci[oó]n|c[oó]digo[-_\s]*(?:de[-_\s]*)?verificaci[oó]n)\b/i;

export interface YokomitsuTwoFactorSignal {
  type: 'input-field' | 'verification-form';
  tagName: string;
  fieldType?: string;
  name?: string;
  id?: string;
  className?: string;
  placeholder?: string;
  autocomplete?: string;
  inputMode?: string;
  maxLength?: string;
}

export interface YokomitsuTwoFactorInspection {
  detected: boolean;
  signals: YokomitsuTwoFactorSignal[];
}

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

export async function inspectYokomitsuTwoFactor(page: Page): Promise<YokomitsuTwoFactorInspection> {
  const signals: YokomitsuTwoFactorSignal[] = [];
  const inputs = page.locator('input:not([type="hidden"]), textarea');
  const inputCount = Math.min(await inputs.count().catch(() => 0), 100);

  for (let index = 0; index < inputCount && signals.length < 10; index += 1) {
    const input = inputs.nth(index);
    if (!await input.isVisible().catch(() => false)) continue;
    const signal = await twoFactorInputSignal(input);
    if (signal) signals.push(signal);
  }

  const forms = page.locator('form');
  const formCount = Math.min(await forms.count().catch(() => 0), 25);
  for (let index = 0; index < formCount && signals.length < 10; index += 1) {
    const form = forms.nth(index);
    if (!await form.isVisible().catch(() => false)) continue;
    const formInputs = form.locator('input:not([type="hidden"]), textarea');
    const visibleInputCount = Math.min(await formInputs.count().catch(() => 0), 20);
    let hasVisibleChallengeInput = false;
    for (let inputIndex = 0; inputIndex < visibleInputCount; inputIndex += 1) {
      if (await formInputs.nth(inputIndex).isVisible().catch(() => false)) {
        hasVisibleChallengeInput = true;
        break;
      }
    }
    if (!hasVisibleChallengeInput) continue;
    const attributes = [
      await optionalAttribute(form, 'id'),
      await optionalAttribute(form, 'class'),
      await optionalAttribute(form, 'name'),
      await optionalAttribute(form, 'action'),
      truncate(await form.textContent().catch(() => undefined), 160),
    ].filter(Boolean).join(' ');
    if (TWO_FACTOR_FORM_PATTERN.test(attributes)) {
      signals.push({
        type: 'verification-form',
        tagName: 'form',
        id: await optionalAttribute(form, 'id'),
        className: await optionalAttribute(form, 'class'),
        name: await optionalAttribute(form, 'name'),
      });
    }
  }

  return { detected: signals.length > 0, signals };
}

export async function detectYokomitsuTwoFactor(page: Page): Promise<boolean> {
  return (await inspectYokomitsuTwoFactor(page)).detected;
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

async function twoFactorInputSignal(locator: ReturnType<Page['locator']>): Promise<YokomitsuTwoFactorSignal | undefined> {
  const fieldType = await optionalAttribute(locator, 'type');
  const name = await optionalAttribute(locator, 'name');
  const id = await optionalAttribute(locator, 'id');
  const className = await optionalAttribute(locator, 'class');
  const placeholder = await optionalAttribute(locator, 'placeholder');
  const autocomplete = await optionalAttribute(locator, 'autocomplete');
  const inputMode = await optionalAttribute(locator, 'inputmode');
  const maxLength = await optionalAttribute(locator, 'maxlength');
  const label = await optionalAttribute(locator, 'aria-label');
  const combined = [
    fieldType,
    name,
    id,
    className,
    placeholder,
    autocomplete,
    inputMode,
    maxLength,
    label,
  ].filter(Boolean).join(' ');
  if (!TWO_FACTOR_FIELD_PATTERN.test(combined)) return undefined;
  return {
    type: 'input-field',
    tagName: 'input',
    fieldType,
    name,
    id,
    className,
    placeholder,
    autocomplete,
    inputMode,
    maxLength,
  };
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
