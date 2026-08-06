import type { ProductRecord } from '../interfaces/scraping.types';
import { cleanText } from './product-quality';

export const YOKOMITSU_LOGIN_URL = 'https://yokomitsuparts.com.uy/v2/login';
export const YOKOMITSU_BASE_URL = 'https://www.yokomitsuparts.com.uy/v2/';
export const YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS = 5;

const SENSITIVE_HEADER_PATTERN = /^(authorization|cookie|set-cookie|x-csrf-token|x-xsrf-token)$/i;
const SENSITIVE_KEY_PATTERN = /(pass|password|passwd|pwd|token|jwt|bearer|authorization|cookie|session|csrf|xsrf|secret)/i;
const CATALOG_URL_HINT = /(catalog|catalogo|producto|productos|repuesto|repuestos|articulo|articulos|stock|precio|precios|marca|marcas|modelo|modelos|search|buscar|busqueda|familia|categoria)/i;

type JsonRecord = Record<string, unknown>;

export interface YokomitsuNetworkCall {
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  contentType?: string;
  requestBody?: unknown;
  responseShape?: unknown;
}

export interface YokomitsuFieldAvailability {
  productName: boolean;
  sourceUrl: boolean;
  sku: boolean;
  referencia: boolean;
  brand: boolean;
  price: boolean;
  currency: boolean;
  stock: boolean;
  availability: boolean;
  description: boolean;
  imageUrl: boolean;
  imageUrls: boolean;
  category: boolean;
  vehicleBrand: boolean;
  vehicleModel: boolean;
  compatibleBrands: boolean;
  compatibleModels: boolean;
}

export interface YokomitsuDiagnosticReport {
  site: 'yokomitsu';
  loginUrl: string;
  status: 'success' | 'missing-env' | 'blocked' | 'login-failed' | 'error';
  authenticated: boolean;
  reachedPortal: boolean;
  login: {
    method?: string;
    endpoint?: string;
    fieldNames: string[];
    usesSessionCookie: boolean;
    usesJwt: boolean;
    usesBearerToken: boolean;
    usesLocalStorage: boolean;
    usesRefreshToken: boolean;
  };
  catalogApiCandidates: YokomitsuNetworkCall[];
  pagination: {
    observedParams: string[];
    observedFields: string[];
  };
  approximateProductCount?: number;
  pricesMayDependOnAuthenticatedUser?: boolean;
  captchaDetected: boolean;
  twoFactorDetected: boolean;
  restrictions: string[];
  samples: ProductRecord[];
  fieldsAvailable: YokomitsuFieldAvailability;
  notes: string[];
  extractedAt: string;
}

export interface YokomitsuCaptchaSignal {
  tagName: string;
  id?: string;
  className?: string;
  title?: string;
  src?: string;
  text?: string;
  visible: boolean;
}

export interface YokomitsuPortalSignals {
  currentUrl: string;
  hasPasswordInput: boolean;
  portalElementCount: number;
  authenticatedCatalogResponses: number;
}

export interface YokomitsuSessionResources {
  context?: {
    clearCookies?: () => Promise<unknown>;
    close?: () => Promise<unknown>;
  };
  browser?: {
    close?: () => Promise<unknown>;
  };
}

export function normalizeYokomitsuPrice(value?: string): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) return undefined;

  const numeric = cleaned
    .replace(/(?:US\$|\$U|\$|UYU|USD)/gi, '')
    .replace(/\s+/g, '')
    .match(/\d[\d.,]*/)?.[0];
  if (!numeric) return undefined;

  const decimalComma = numeric.match(/^(.*),(\d{1,2})$/);
  if (decimalComma) {
    return `${decimalComma[1].replace(/\./g, '')}.${decimalComma[2]}`;
  }

  if (/^\d{1,3}(?:\.\d{3})+$/.test(numeric)) {
    return numeric.replace(/\./g, '');
  }

  return numeric.replace(',', '.');
}

export function hasVisibleYokomitsuCaptchaChallenge(signals: YokomitsuCaptchaSignal[]): boolean {
  return signals.some((signal) => {
    const evidence = [signal.id, signal.className, signal.title, signal.src, signal.text].filter(Boolean).join(' ');
    const captchaLike = /captcha|recaptcha|hcaptcha|g-recaptcha|cf-turnstile|challenge/i.test(evidence);
    const interactiveTag = /^(iframe|textarea|input|button|div)$/i.test(signal.tagName);
    return signal.visible && captchaLike && interactiveTag;
  });
}

export function hasReachedYokomitsuPortal(signals: YokomitsuPortalSignals): boolean {
  return !/\/login(?:[/?#]|$)/i.test(signals.currentUrl)
    && !signals.hasPasswordInput
    && (signals.portalElementCount > 0 || signals.authenticatedCatalogResponses > 0);
}

export function hasYokomitsuManualLoginTimedOut(startedAtMs: number, nowMs: number, timeoutMs: number): boolean {
  return nowMs - startedAtMs >= timeoutMs;
}

export async function closeYokomitsuSessionResources(resources: YokomitsuSessionResources): Promise<void> {
  try {
    await resources.context?.clearCookies?.();
  } finally {
    try {
      await resources.context?.close?.();
    } finally {
      await resources.browser?.close?.();
    }
  }
}

export function inferYokomitsuCurrency(value?: string, explicit?: unknown): string | undefined {
  const explicitText = asText(explicit)?.toUpperCase();
  if (explicitText === 'UYU' || explicitText === 'USD') return explicitText;
  if (!value) return undefined;
  if (/US\$|USD/i.test(value)) return 'USD';
  if (/\$U|UYU|\$/i.test(value)) return 'UYU';
  return undefined;
}

export function isLikelyYokomitsuCatalogUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return normalizeHostname(url.hostname) === 'yokomitsuparts.com.uy' && CATALOG_URL_HINT.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return value.replace(/(authorization|cookie|token|password|pass)=([^&\s]+)/gi, '$1=[REDACTED]');
  }
}

export function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER_PATTERN.test(key) ? '[REDACTED]' : value,
    ]),
  );
}

export function sanitizeRequestBody(body: string | null | undefined): unknown {
  if (!body) return undefined;
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  try {
    return sanitizeJson(JSON.parse(trimmed));
  } catch {
    const params = new URLSearchParams(trimmed);
    if (Array.from(params.keys()).length > 0) {
      return Object.fromEntries(Array.from(params.keys()).map((key) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : '[VALUE]',
      ]));
    }
    return '[NON_JSON_BODY_REDACTED]';
  }
}

export function extractFieldNamesFromBody(body: string | null | undefined): string[] {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body);
    return collectKeys(parsed);
  } catch {
    const params = new URLSearchParams(body);
    return Array.from(new Set(Array.from(params.keys())));
  }
}

export function summarizeJsonShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      itemKeys: collectKeys(value[0]).slice(0, 40),
    };
  }
  if (!isRecord(value)) return { type: typeof value };
  return {
    type: 'object',
    keys: Object.keys(value).slice(0, 40),
    arrayFields: Object.entries(value)
      .filter(([, child]) => Array.isArray(child))
      .map(([key, child]) => ({ key, length: (child as unknown[]).length, itemKeys: collectKeys((child as unknown[])[0]).slice(0, 30) })),
  };
}

export function extractYokomitsuProductsFromJson(value: unknown, baseUrl = YOKOMITSU_BASE_URL): ProductRecord[] {
  return findProductArrays(value)
    .flatMap((record) => normalizeYokomitsuProduct(record, baseUrl))
    .slice(0, YOKOMITSU_MAX_DIAGNOSTIC_PRODUCTS);
}

export function inferYokomitsuFieldsAvailable(products: ProductRecord[]): YokomitsuFieldAvailability {
  const has = (predicate: (product: ProductRecord) => unknown) => products.some((product) => Boolean(predicate(product)));
  return {
    productName: has((product) => product.productName),
    sourceUrl: has((product) => product.sourceUrl),
    sku: has((product) => product.sku),
    referencia: has((product) => product.attributes?.referencia),
    brand: has((product) => product.brand),
    price: has((product) => product.price),
    currency: has((product) => product.currency),
    stock: has((product) => product.stock),
    availability: has((product) => product.availability),
    description: has((product) => product.description),
    imageUrl: has((product) => product.imageUrl),
    imageUrls: has((product) => product.imageUrls?.length),
    category: has((product) => product.category),
    vehicleBrand: has((product) => product.attributes?.vehicleBrand),
    vehicleModel: has((product) => product.attributes?.vehicleModel),
    compatibleBrands: has((product) => product.compatibleBrands?.length),
    compatibleModels: has((product) => product.compatibleModels?.length),
  };
}

export function inferApproximateProductCount(value: unknown): number | undefined {
  const candidates = collectCountCandidates(value);
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

export function inferPaginationFromCalls(calls: YokomitsuNetworkCall[]): { observedParams: string[]; observedFields: string[] } {
  const params = new Set<string>();
  const fields = new Set<string>();
  for (const call of calls) {
    try {
      const url = new URL(call.url);
      for (const key of url.searchParams.keys()) {
        if (/page|pagina|pag|offset|limit|size|per_page|desde|hasta|start|length/i.test(key)) params.add(key);
      }
    } catch { /* ignore invalid URLs */ }
    for (const key of collectShapeKeys(call.responseShape)) {
      if (/page|pagina|pag|offset|limit|total|count|pages|records|draw|start|length/i.test(key)) fields.add(key);
    }
  }
  return { observedParams: Array.from(params).sort(), observedFields: Array.from(fields).sort() };
}

function normalizeYokomitsuProduct(record: JsonRecord, baseUrl: string): ProductRecord[] {
  const productName = firstText(record, ['productName', 'name', 'nombre', 'descripcion', 'description', 'detalle', 'articulo']);
  const sku = firstText(record, ['sku', 'codigo', 'code', 'cod_articulo', 'codArticulo', 'id_producto', 'idProducto', 'referencia']);
  const rawPrice = firstText(record, ['price', 'precio', 'precioVenta', 'precio_venta', 'importe', 'monto']);
  if (!productName && !sku) return [];

  const imageUrls = uniqueStrings([
    firstText(record, ['imageUrl', 'imagen', 'image', 'foto', 'urlImagen']),
    ...arrayTexts(record, ['imageUrls', 'imagenes', 'images', 'fotos']),
  ].flatMap((value) => normalizeUrl(value, baseUrl)));
  const sourceUrl = normalizeUrl(firstText(record, ['sourceUrl', 'url', 'link', 'href', 'permalink']), baseUrl)[0]
    ?? (sku ? new URL(`producto/${encodeURIComponent(sku)}`, baseUrl).toString() : baseUrl);
  const stock = firstText(record, ['stock', 'existencia', 'cantidad', 'disponible']);
  const vehicleBrand = firstText(record, ['vehicleBrand', 'marcaVehiculo', 'marca_vehiculo', 'marcaAuto', 'marca']);
  const vehicleModel = firstText(record, ['vehicleModel', 'modeloVehiculo', 'modelo_vehiculo', 'modeloAuto', 'modelo']);
  const referencia = firstText(record, ['referencia', 'reference', 'ref', 'oem']);

  return [{
    productName,
    sourceUrl,
    sku,
    brand: firstText(record, ['brand', 'marcaProducto', 'marca_producto', 'fabricante']),
    price: normalizeYokomitsuPrice(rawPrice),
    currency: inferYokomitsuCurrency(rawPrice, firstText(record, ['currency', 'moneda'])),
    stock,
    availability: inferAvailability(record, stock),
    description: firstText(record, ['description', 'descripcionLarga', 'detalle', 'observaciones']),
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    category: firstText(record, ['category', 'categoria', 'familia', 'rubro']),
    compatibleBrands: arrayTexts(record, ['compatibleBrands', 'marcasCompatibles', 'marcas']),
    compatibleModels: arrayTexts(record, ['compatibleModels', 'modelosCompatibles', 'modelos']),
    attributes: compactAttributes({ referencia, vehicleBrand, vehicleModel }),
    provider: 'Yokomitsu',
    extractedAt: new Date().toISOString(),
  }];
}

function findProductArrays(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    const records = value.filter(isRecord);
    if (records.some(looksLikeProductRecord)) return records;
    return value.flatMap(findProductArrays);
  }
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(findProductArrays);
}

function looksLikeProductRecord(record: JsonRecord): boolean {
  const keys = Object.keys(record).map((key) => key.toLowerCase());
  return keys.some((key) => ['sku', 'codigo', 'cod_articulo', 'nombre', 'descripcion', 'precio', 'stock'].includes(key));
}

function inferAvailability(record: JsonRecord, stock?: string): string | undefined {
  const raw = firstText(record, ['availability', 'disponibilidad', 'estado']);
  if (raw) return raw;
  if (!stock) return undefined;
  const numericStock = Number(stock.replace(',', '.'));
  if (Number.isFinite(numericStock)) return numericStock > 0 ? 'in_stock' : 'out_of_stock';
  return /sin stock|agotado|no disponible/i.test(stock) ? 'out_of_stock' : 'in_stock';
}

function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (!isRecord(value)) return value === undefined ? undefined : '[VALUE]';
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeJson(child),
  ]));
}

function collectKeys(value: unknown): string[] {
  const keys = new Set<string>();
  const visit = (child: unknown) => {
    if (Array.isArray(child)) {
      child.slice(0, 5).forEach(visit);
      return;
    }
    if (!isRecord(child)) return;
    Object.entries(child).forEach(([key, nested]) => {
      keys.add(key);
      if (keys.size < 100) visit(nested);
    });
  };
  visit(value);
  return Array.from(keys);
}

function collectShapeKeys(value: unknown): string[] {
  if (!isRecord(value)) return collectKeys(value);
  const direct = collectKeys(value);
  const listed = ['keys', 'itemKeys', 'arrayFields'].flatMap((key) => {
    const child = value[key];
    if (Array.isArray(child)) {
      return child.flatMap((entry) => typeof entry === 'string' ? [entry] : collectShapeKeys(entry));
    }
    return [];
  });
  return Array.from(new Set([...direct, ...listed]));
}

function collectCountCandidates(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(collectCountCandidates);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const nested = collectCountCandidates(child);
    if (/total|count|cantidad|records|filtered/i.test(key) && (typeof child === 'number' || typeof child === 'string')) {
      const parsed = Number(String(child).replace(/\D/g, ''));
      return Number.isFinite(parsed) && parsed > 0 ? [parsed, ...nested] : nested;
    }
    return nested;
  });
}

function firstText(record: JsonRecord, keys: string[]): string | undefined {
  const normalized = keys.map(normalizeKey);
  for (const [key, value] of Object.entries(record)) {
    if (normalized.includes(normalizeKey(key))) {
      const text = asText(value);
      if (text) return text;
    }
  }
  return undefined;
}

function arrayTexts(record: JsonRecord, keys: string[]): string[] {
  const normalized = keys.map(normalizeKey);
  const values: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (!normalized.includes(normalizeKey(key))) continue;
    if (Array.isArray(value)) values.push(...value.map(asText).filter((item): item is string => Boolean(item)));
    else {
      const text = asText(value);
      if (text) values.push(...text.split(/[,;|]+/).map((part) => cleanText(part)).filter((item): item is string => Boolean(item)));
    }
  }
  return uniqueStrings(values);
}

function normalizeUrl(value: string | undefined, baseUrl: string): string[] {
  if (!value) return [];
  try {
    const url = new URL(value, baseUrl);
    return /^https?:$/i.test(url.protocol) ? [sanitizeUrl(url.toString())] : [];
  } catch {
    return [];
  }
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? cleanText(String(value)) : undefined;
}

function normalizeKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '');
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function compactAttributes(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
