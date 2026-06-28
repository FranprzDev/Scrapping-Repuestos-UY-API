export type PreferredMethod = 'http' | 'api' | 'playwright-fallback';

export interface DomainRule {
  id: string;
  hostnames: string[];
  seedUrls?: string[];
  preferredMethod: PreferredMethod;
  productUrlPatterns: RegExp[];
  categoryUrlPatterns: RegExp[];
  excludeUrlPatterns: RegExp[];
  positiveAvailabilityTexts: string[];
  negativeAvailabilityTexts: string[];
  detailSelectors?: {
    title?: string[];
    price?: string[];
    description?: string[];
    brand?: string[];
    sku?: string[];
    image?: string[];
  };
}

export interface AdmittedHouse {
  id: string;
  label: string;
  canonicalHostname: string;
  hostnames: string[];
}

export const DOMAIN_RULES: DomainRule[] = [
  {
    id: 'taxitor',
    hostnames: ['taxitor.uy', 'www.taxitor.uy'],
    seedUrls: ['https://taxitor.uy/articulos/filtro/1/-/-/'],
    preferredMethod: 'http',
    productUrlPatterns: [/\/articulos\/mostrar\//i],
    categoryUrlPatterns: [/\/articulos\/filtro\//i, /\/kits/i],
    excludeUrlPatterns: [/\/resources\//i, /\/terminos/i],
    positiveAvailabilityTexts: ['agregar al carrito', 'carrito'],
    negativeAvailabilityTexts: ['agotado', 'sin stock', 'out of stock', 'no disponible'],
    detailSelectors: {
      title: ['h1'],
      price: ['h1 + p', '.price', '[class*="precio"]'],
      image: ['main img', '.carousel img'],
    },
  },
  {
    id: 'acesur',
    hostnames: ['acesur.uy', 'www.acesur.uy'],
    seedUrls: ['https://acesur.uy/escritorio/ofertas/INTERNET'],
    preferredMethod: 'api',
    productUrlPatterns: [],
    categoryUrlPatterns: [/\/escritorio\/ofertas\/internet/i],
    excludeUrlPatterns: [/\/escritorio\/home/i],
    positiveAvailabilityTexts: ['stock', 'disponible'],
    negativeAvailabilityTexts: ['sin stock', 'agotado', 'no comprable'],
  },
  {
    id: 'chaparei',
    hostnames: ['chaparei.com', 'www.chaparei.com'],
    seedUrls: ['https://www.chaparei.com/productos/'],
    preferredMethod: 'http',
    productUrlPatterns: [
      /\/catalogo\/[^/?#]+\/.+\/?$/i,
    ],
    categoryUrlPatterns: [
      /\/productos\/(?:productos\.php)?\?(?=.*\bm=\d+)/i,
      /\/productos\/?$/i,
      /\/catalogo\//i,
      /\/ofertas/i,
      /\/outlet/i,
    ],
    excludeUrlPatterns: [/\/mi-cuenta/i, /\/faq/i, /\/contacto/i, /mercadolibre/i],
    positiveAvailabilityTexts: ['comprar', 'agregar', 'iva inc.', 'en stock', 'disponible'],
    negativeAvailabilityTexts: ['agotado', 'sin stock', 'consultar', 'no disponible'],
    detailSelectors: {
      title: ['h1', 'h2'],
      brand: ['.copete_ficha', '[class*="copete"]', '[class*="marca"]'],
      price: ['#precio_ent_actual', '[itemprop="price"]', '.precio_cont_mas .entero', '.prod_preciomas .entero', '[class*="price"]', '[class*="precio"]'],
      description: ['article p', '.descripcion', '.summary p', '.copete_ficha'],
      image: ['main img', 'article img'],
    },
  },
  {
    id: 'selvir',
    hostnames: ['selvir.com.uy', 'www.selvir.com.uy'],
    seedUrls: [
      'https://www.selvir.com.uy/accesorios/',
      'https://www.selvir.com.uy/aceites/',
      'https://www.selvir.com.uy/arranques-y-alternadores/',
      'https://www.selvir.com.uy/bombas/',
      'https://www.selvir.com.uy/carroceria/',
      'https://www.selvir.com.uy/correas/',
      'https://www.selvir.com.uy/diferencial-y-cardan/',
      'https://www.selvir.com.uy/direccion/',
      'https://www.selvir.com.uy/filtros-y-soportes/',
      'https://www.selvir.com.uy/freno-y-embrague/',
      'https://www.selvir.com.uy/general/',
      'https://www.selvir.com.uy/herramientas/',
      'https://www.selvir.com.uy/lamparas/',
      'https://www.selvir.com.uy/limpieza-y-mantenimiento-del-vehiculo/',
      'https://www.selvir.com.uy/limpieza-cuidado-y-emergencia/',
      'https://www.selvir.com.uy/mangones-y-canos/',
      'https://www.selvir.com.uy/motor/',
      'https://www.selvir.com.uy/neumaticos/',
      'https://www.selvir.com.uy/otros/',
      'https://www.selvir.com.uy/sensores/',
      'https://www.selvir.com.uy/suspension/',
      'https://www.selvir.com.uy/tanques-y-flotadores/',
    ],
    preferredMethod: 'http',
    productUrlPatterns: [/\/product\//i],
    categoryUrlPatterns: [
      /\/product-category\//i,
      /\/ofertas\/?$/i,
      /\/page\/\d+\/?$/i,
      /\/(?:product-category\/)?accesorios\/?$/i,
      /\/(?:product-category\/)?aceites\/?$/i,
      /\/(?:product-category\/)?arranques-y-alternadores\/?$/i,
      /\/(?:product-category\/)?bombas\/?$/i,
      /\/(?:product-category\/)?carroceria\/?$/i,
      /\/(?:product-category\/)?correas\/?$/i,
      /\/(?:product-category\/)?diferencial-y-cardan\/?$/i,
      /\/(?:product-category\/)?direccion\/?$/i,
      /\/(?:product-category\/)?filtros-y-soportes\/?$/i,
      /\/(?:product-category\/)?freno-y-embrague\/?$/i,
      /\/(?:product-category\/)?general\/?$/i,
      /\/(?:product-category\/)?herramientas\/?$/i,
      /\/(?:product-category\/)?lamparas\/?$/i,
      /\/(?:product-category\/)?limpieza-y-mantenimiento-del-vehiculo\/?$/i,
      /\/(?:product-category\/)?limpieza-cuidado-y-emergencia\/?$/i,
      /\/(?:product-category\/)?mangones-y-canos\/?$/i,
      /\/(?:product-category\/)?motor\/?$/i,
      /\/(?:product-category\/)?neumaticos\/?$/i,
      /\/(?:product-category\/)?otros\/?$/i,
      /\/(?:product-category\/)?sensores\/?$/i,
      /\/(?:product-category\/)?suspension\/?$/i,
      /\/(?:product-category\/)?tanques-y-flotadores\/?$/i,
    ],
    excludeUrlPatterns: [/\/wp-json\//i, /\/wp-admin\//i, /\/carrito/i, /\/mi-cuenta/i, /\/marca\//i],
    positiveAvailabilityTexts: ['anadir al carrito', 'añadir al carrito', 'buy', 'agregar al carrito'],
    negativeAvailabilityTexts: ['agotado', 'sin stock', 'out of stock', 'no disponible'],
    detailSelectors: {
      title: ['h1.product_title', 'h1'],
      price: ['.price-number', '.product-info-price .price-number', '.product-info-price', '.summary .woocommerce-Price-amount', '[class*="price-number"]', '[class*="price"]'],
      description: ['#tab-description', '.woocommerce-product-details__short-description', '.summary p'],
      image: ['figure img', '.woocommerce-product-gallery img', 'meta[property="og:image"]'],
    },
  },
  {
    id: 'feyvi',
    hostnames: ['feyvi.com.uy', 'www.feyvi.com.uy'],
    preferredMethod: 'http',
    productUrlPatterns: [/^https?:\/\/(?:www\.)?feyvi\.com\.uy\/repuestos\/(?:[^/]+\/){2}[^/]+\/?$/i],
    categoryUrlPatterns: [
      /^https?:\/\/(?:www\.)?feyvi\.com\.uy\/repuestos\/(?:[^/]+\/){1,2}(?:page-\d+\/)?$/i,
    ],
    excludeUrlPatterns: [/\/contacto/i, /\/mi-cuenta/i, /\/carrito/i],
    positiveAvailabilityTexts: ['agregar al carrito', 'comprar', 'anadir al carrito', 'añadir al carrito'],
    negativeAvailabilityTexts: ['agotado', 'sin stock', 'out of stock', 'no disponible'],
    detailSelectors: {
      title: ['h1.product-title', 'h1', '.product-title'],
      price: ['.ty-price', '.price', '[class*="price"]', '[class*="precio"]', '.ty-price .ty-price-num'],
      description: ['.product-description', 'main p', '.summary', '[class*="description"]'],
      sku: ['.ty-control-group__item', '.sku', 'body'],
      image: ['.ty-product-img img', '.product-image img', 'main img', 'meta[property="og:image"]'],
    },
  },
];

export function findDomainRule(url: string): DomainRule | undefined {
  try {
    const hostname = normalizeHostname(new URL(url).hostname);
    return DOMAIN_RULES.find((rule) => rule.hostnames.map((value) => normalizeHostname(value)).includes(hostname));
  } catch {
    return undefined;
  }
}

export function getAllowedHostnames(): string[] {
  return Array.from(
    new Set(
      DOMAIN_RULES.flatMap((rule) => rule.hostnames.map((hostname) => normalizeHostname(hostname))),
    ),
  );
}

export function isAdmittedHouseUrl(url: string): boolean {
  try {
    const hostname = normalizeHostname(new URL(url).hostname);
    return getAllowedHostnames().includes(hostname);
  } catch {
    return false;
  }
}

export function getSeedUrls(url: string, rule?: DomainRule): string[] {
  const seeds = new Set<string>([url]);
  rule?.seedUrls?.forEach((seed) => seeds.add(seed));
  return Array.from(seeds);
}

export const ADMITTED_HOUSES: AdmittedHouse[] = DOMAIN_RULES.map((rule) => ({
  id: rule.id,
  label: formatHouseLabel(rule.id),
  canonicalHostname: normalizeHostname(rule.hostnames[0] ?? rule.id),
  hostnames: rule.hostnames.map((hostname) => normalizeHostname(hostname)),
}));

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, '');
}

function formatHouseLabel(id: string): string {
  return id
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}
