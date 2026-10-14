import { parse, type HTMLElement } from 'node-html-parser';
import { cleanText } from './product-quality';

/** Uruguay money formats: $1.237, $1.237,50, $832.04 and $U 832,04. */
export function normalizeYokomitsuPrice(value?: string): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) return undefined;
  const numeric = cleaned
    .replace(/(?:US\$|\$U|\$|UYU|USD)/gi, '')
    .replace(/\s+/g, '')
    .match(/\d[\d.,]*/)?.[0];
  if (!numeric) return undefined;
  const decimalComma = numeric.match(/^(.*),(\d{1,2})$/);
  if (decimalComma) return decimalComma[1].replace(/\./g, '') + '.' + decimalComma[2];
  if (/^\d{1,3}(?:\.\d{3})+$/.test(numeric)) return numeric.replace(/\./g, '');
  return numeric.replace(',', '.');
}

/** VAT is included once, only when expressly shown as +IVA. */
export function normalizeYokomitsuCostPrice(rawPrice?: string, plusVat = false): string | undefined {
  const normalized = normalizeYokomitsuPrice(rawPrice);
  if (!normalized) return undefined;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return undefined;
  const withVat = plusVat || /\+\s*IVA\b/i.test(rawPrice ?? '')
    ? Math.round(amount * 122 + Number.EPSILON) / 100
    : amount;
  return Number.isFinite(withVat) && withVat > 0 && withVat <= 10_000_000
    ? withVat.toFixed(2)
    : undefined;
}

export function isYokomitsuDetailUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:'
      && url.hostname.replace(/^www\./, '') === 'yokomitsuparts.com.uy'
      && url.pathname.includes('/producto-detalle/');
  } catch { return false; }
}

/** Verify the price and SKU from the real detail, not a badge, old price or related card. */
export function verifiedYokomitsuDetailProduct(
  html: string | HTMLElement,
  url: string,
  expectedSku: string | null,
): { sku: string; price: string } | undefined {
  if (!isYokomitsuDetailUrl(url)) return undefined;
  const root = typeof html === 'string' ? parse(html) : html;
  const panels = root.querySelectorAll('#prices-product');
  if (panels.length !== 1) return undefined;
  const panel = panels[0];
  const heading = panel.querySelector('.precio-oferta h2') ?? panel.querySelector('h3');
  if (!heading) return undefined;
  const directText = heading.childNodes
    .filter((node) => node.nodeType === 3)
    .map((node) => node.rawText)
    .join(' ').trim();
  if (!/^(?:\$U|\$|UYU)\s*\d[\d.,]*(?:\s*\+\s*IVA)?$/i.test(directText)) return undefined;

  const codes = root.querySelectorAll('#code-product');
  const detailCode = root.querySelector('.producto-info #code-product')?.text.trim()
    ?? (codes.length === 1 ? codes[0].text.trim() : undefined);
  const detailCard = root.querySelector('.producto-detalle[data-codprod]');
  const singleCard = root.querySelectorAll('[data-codprod]');
  const fallbackCode = expectedSku?.trim()
    ? (detailCard?.getAttribute('data-codprod')?.trim()
      ?? (singleCard.length === 1 ? singleCard[0].getAttribute('data-codprod')?.trim() : undefined))
    : undefined;
  const sku = detailCode || fallbackCode;
  if (!sku || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,48}$/.test(sku)) return undefined;
  if (expectedSku?.trim() && sku !== expectedSku.trim()) return undefined;
  const price = normalizeYokomitsuCostPrice(directText, /\+\s*IVA\b/i.test(panel.text));
  return price ? { sku, price } : undefined;
}
