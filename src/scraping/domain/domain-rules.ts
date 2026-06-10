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
    sku?: string[];
    image?: string[];
  };
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
    seedUrls: ['https://www.chaparei.com/productos/?m=171'],
    preferredMethod: 'http',
    productUrlPatterns: [/\/catalogo\/.+-[a-z]\d{7}\/?$/i],
    categoryUrlPatterns: [/\/productos\/\?m=/i, /\/catalogo\//i, /\/ofertas/i, /\/outlet/i],
    excludeUrlPatterns: [/\/mi-cuenta/i, /\/faq/i, /\/contacto/i, /mercadolibre/i],
    positiveAvailabilityTexts: ['comprar', 'agregar', 'iva inc.'],
    negativeAvailabilityTexts: ['agotado', 'sin stock', 'consultar'],
    detailSelectors: {
      title: ['h1', 'h2'],
      price: ['#precio_ent_actual', '[itemprop="price"]', '.precio_cont_mas .entero', '.prod_preciomas .entero', '[class*="price"]', '[class*="precio"]'],
      description: ['article p', '.descripcion', '.summary p', '.copete_ficha'],
      sku: ['body'],
      image: ['main img', 'article img'],
    },
  },
  {
    id: 'selvir',
    hostnames: ['selvir.com.uy', 'www.selvir.com.uy'],
    seedUrls: ['https://www.selvir.com.uy/product-category/carroceria/'],
    preferredMethod: 'http',
    productUrlPatterns: [/\/product\//i],
    categoryUrlPatterns: [/\/product-category\//i, /\/productos\/?$/i, /\/ofertas\/?$/i, /\/camiones\/?$/i],
    excludeUrlPatterns: [/\/wp-json\//i, /\/wp-admin\//i, /\/carrito/i, /\/mi-cuenta/i],
    positiveAvailabilityTexts: ['anadir al carrito', 'añadir al carrito', 'buy', 'agregar al carrito'],
    negativeAvailabilityTexts: ['agotado', 'sin stock', 'out of stock', 'no disponible'],
    detailSelectors: {
      title: ['h1.product_title', 'h1'],
      price: ['.price', '.summary .woocommerce-Price-amount', '[class*="price"]'],
      description: ['#tab-description', '.woocommerce-product-details__short-description', '.summary p'],
      sku: ['.sku_wrapper', 'body'],
      image: ['figure img', '.woocommerce-product-gallery img', 'meta[property="og:image"]'],
    },
  },
  {
    id: 'feyvi',
    hostnames: ['feyvi.com.uy', 'www.feyvi.com.uy'],
    preferredMethod: 'playwright-fallback',
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
    const hostname = new URL(url).hostname.toLowerCase();
    return DOMAIN_RULES.find((rule) => rule.hostnames.includes(hostname));
  } catch {
    return undefined;
  }
}

export function getSeedUrls(url: string, rule?: DomainRule): string[] {
  const seeds = new Set<string>([url]);
  rule?.seedUrls?.forEach((seed) => seeds.add(seed));
  return Array.from(seeds);
}
