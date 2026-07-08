import { ProductRecord } from '../interfaces/scraping.types';
import { cleanText } from './product-quality';

export interface VehicleBrandDefinition {
  id: string;
  label: string;
  aliases: string[];
}

export interface InferredVehicleBrand {
  id: string;
  label: string;
  confidence: 'alias' | 'explicit' | 'fallback';
  evidence?: string;
}

export const OTHER_VEHICLE_BRAND_ID = 'otros';

export const VEHICLE_BRANDS: VehicleBrandDefinition[] = [
  brand('fiat', 'Fiat', ['fi']),
  brand('toyota', 'Toyota'),
  brand('chevrolet', 'Chevrolet', ['chevy']),
  brand('ford', 'Ford'),
  brand('renault', 'Renault'),
  brand('volkswagen', 'Volkswagen', ['vw', 'v.w.', 'volkswagen']),
  brand('peugeot', 'Peugeot'),
  brand('citroen', 'Citroen', ['citroën']),
  brand('hyundai', 'Hyundai'),
  brand('kia', 'Kia'),
  brand('nissan', 'Nissan'),
  brand('chery', 'Chery'),
  brand('suzuki', 'Suzuki'),
  brand('bmw', 'BMW'),
  brand('mercedes-benz', 'Mercedes Benz', ['mercedes', 'mb']),
  brand('honda', 'Honda'),
  brand('mitsubishi', 'Mitsubishi'),
  brand('mazda', 'Mazda'),
  brand('isuzu', 'Isuzu'),
  brand('jeep', 'Jeep'),
  brand('dodge', 'Dodge'),
  brand('chrysler', 'Chrysler'),
  brand('geely', 'Geely'),
  brand('byd', 'BYD'),
  brand('audi', 'Audi'),
  brand('volvo', 'Volvo'),
  brand('subaru', 'Subaru'),
  brand('daewoo', 'Daewoo'),
  brand('daihatsu', 'Daihatsu'),
  brand('jac', 'JAC'),
  brand('gwm', 'GWM'),
  brand('foton', 'Foton'),
  brand('iveco', 'Iveco'),
  brand('scania', 'Scania'),
  brand('agrale', 'Agrale'),
  brand('man', 'MAN'),
  brand(OTHER_VEHICLE_BRAND_ID, 'Otros'),
];

const VEHICLE_BRANDS_BY_ID = new Map(VEHICLE_BRANDS.map((item) => [item.id, item]));
const ALIASES = VEHICLE_BRANDS.flatMap((definition) =>
  definition.aliases.map((alias) => ({
    definition,
    alias,
    normalizedAlias: normalizeComparable(alias),
  })),
);

export function inferVehicleBrands(product: ProductRecord): InferredVehicleBrand[] {
  const explicitBrands = inferExplicitVehicleBrands(product.compatibleBrands);
  if (explicitBrands.length > 0) {
    return explicitBrands;
  }

  const evidenceText = buildEvidenceText(product);
  const normalizedEvidence = normalizeComparable(evidenceText);
  const matches: InferredVehicleBrand[] = [];

  for (const item of ALIASES) {
    if (item.definition.id === OTHER_VEHICLE_BRAND_ID || !item.normalizedAlias) {
      continue;
    }

    if (hasAlias(normalizedEvidence, item.normalizedAlias)) {
      matches.push({
        id: item.definition.id,
        label: item.definition.label,
        confidence: 'alias',
        evidence: item.alias,
      });
    }
  }

  const deduped = dedupeBrands(matches);
  if (deduped.length > 0) {
    return deduped;
  }

  const other = VEHICLE_BRANDS_BY_ID.get(OTHER_VEHICLE_BRAND_ID);
  return [{
    id: OTHER_VEHICLE_BRAND_ID,
    label: other?.label ?? 'Otros',
    confidence: 'fallback',
    evidence: 'no vehicle brand detected',
  }];
}

function inferExplicitVehicleBrands(values?: string[]): InferredVehicleBrand[] {
  const matches: InferredVehicleBrand[] = [];

  for (const value of values ?? []) {
    const label = cleanText(value);
    if (!label) {
      continue;
    }

    const normalized = normalizeComparable(label);
    const known = VEHICLE_BRANDS.find((definition) =>
      definition.id !== OTHER_VEHICLE_BRAND_ID
      && definition.aliases.some((alias) => hasAlias(normalized, normalizeComparable(alias))),
    );
    matches.push(known
      ? { id: known.id, label: known.label, confidence: 'alias', evidence: label }
      : { id: normalized.replace(/\s+/g, '-'), label, confidence: 'explicit', evidence: label });
  }

  return dedupeBrands(matches);
}

export function normalizeVehicleBrandId(value?: string): string | undefined {
  const normalized = normalizeComparable(value ?? '');
  if (!normalized) {
    return undefined;
  }

  for (const definition of VEHICLE_BRANDS) {
    if (definition.id === normalized || normalizeComparable(definition.label) === normalized) {
      return definition.id;
    }

    if (definition.aliases.some((alias) => normalizeComparable(alias) === normalized)) {
      return definition.id;
    }
  }

  return undefined;
}

export function resolveVehicleBrandFilterId(value?: string): string | undefined {
  const known = normalizeVehicleBrandId(value);
  if (known) {
    return known;
  }

  const normalized = normalizeComparable(value ?? '');
  return normalized ? normalized.replace(/\s+/g, '-') : undefined;
}

export function getVehicleBrandLabel(id: string): string | undefined {
  return VEHICLE_BRANDS_BY_ID.get(id)?.label;
}

function brand(id: string, label: string, aliases: string[] = []): VehicleBrandDefinition {
  return {
    id,
    label,
    aliases: Array.from(new Set([label, id, ...aliases])),
  };
}

function buildEvidenceText(product: ProductRecord): string {
  return [
    product.productName,
    product.description,
    product.category,
    product.brand,
    product.sourceUrl,
    product.compatibleBrands?.join(' '),
    product.compatibleVehicles?.join(' '),
    Object.values(product.attributes ?? {}).join(' '),
  ].map((value) => cleanText(value)).filter(Boolean).join(' ');
}

function dedupeBrands(matches: InferredVehicleBrand[]): InferredVehicleBrand[] {
  const map = new Map<string, InferredVehicleBrand>();
  for (const match of matches) {
    if (!map.has(match.id)) {
      map.set(match.id, match);
    }
  }
  return Array.from(map.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function hasAlias(normalizedEvidence: string, normalizedAlias: string): boolean {
  if (!normalizedEvidence || !normalizedAlias) {
    return false;
  }

  const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i').test(normalizedEvidence);
}

function normalizeComparable(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
