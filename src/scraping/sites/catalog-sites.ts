import type { CatalogSiteConfig } from './types';
import { GENERATED_CATALOG_SITES } from './generated-sites';

const noAuth = { type: 'none' } as const;
const defaultPagination = { type: 'next-link' } as const;

export const CATALOG_SITES: CatalogSiteConfig[] = [
  existingSite({
    id: 'taxitor',
    label: 'Taxitor',
    hostname: 'taxitor.uy',
    seedUrls: ['https://taxitor.uy/articulos/filtro/1/-/-/'],
    productUrlPatterns: [/\/articulos\/mostrar\//i],
    categoryUrlPatterns: [/\/articulos\/filtro\//i, /\/kits/i],
  }),
  existingSite({
    id: 'grfrenos',
    label: 'GR Frenos',
    hostname: 'grfrenos.uy',
    seedUrls: ['https://www.grfrenos.uy/home/'],
    productUrlPatterns: [/\/art-\d+\/?$/i],
    categoryUrlPatterns: [/\/buscardor\.php\?marcas=\d+---/i, /\/marcas-\d+---/i],
  }),
  existingSite({
    id: 'multishop',
    label: 'Multishop',
    hostname: 'multishop.com.uy',
    seedUrls: ['https://www.multishop.com.uy/'],
    platform: 'shopify',
    productUrlPatterns: [/\/products\/[^/?#]+\/?$/i],
    categoryUrlPatterns: [/\/collections\//i],
  }),
  existingSite({
    id: 'cymaco',
    label: 'Cymaco',
    hostname: 'cymaco.com.uy',
    seedUrls: ['https://cymaco.com.uy/catalogo'],
    platform: 'fenicio',
    productUrlPatterns: [/\/catalogo\/[^/?#]+_[^/?#]+$/i],
    categoryUrlPatterns: [/\/catalogo(?:\/|\?|$)/i],
  }),
  existingSite({
    id: 'familcar',
    label: 'Familcar',
    hostname: 'familcar.com',
    seedUrls: ['https://www.familcar.com/'],
    platform: 'fenicio',
    productUrlPatterns: [/\/catalogo\/[^/?#]+_[^/?#]+$/i],
    categoryUrlPatterns: [/\/catalogo(?:\/|\?|$)/i, /^https?:\/\/(?:www\.)?familcar\.com\/[a-z0-9-]+\/?(?:\?.*)?$/i],
  }),
  existingSite({
    id: 'europarts',
    label: 'Europarts',
    hostname: 'europarts.com.uy',
    seedUrls: ['https://www.europarts.com.uy/es/search?recordsize=100'],
    productUrlPatterns: [/\/es\/[^/?#]+\/product\/\d+\/?$/i],
    categoryUrlPatterns: [/\/es\/search(?:\?|$)/i],
  }),
  existingSite({
    id: 'container',
    label: 'Container',
    hostname: 'container.com.uy',
    seedUrls: ['https://container.com.uy/Home/Index?page=1&filter=&familia=&modelo='],
    productUrlPatterns: [/\/Home\/SearchById\?filter=[^&#]+/i],
    categoryUrlPatterns: [/\/Home\/Index(?:\/|\?|$)/i],
    paginationStrategy: { type: 'page-param', param: 'page', start: 1, maxPages: 1100 },
    requestDelay: 500,
  }),
  plannedSite('lestido', 'Tienda Lestido', 'tienda.lestido.com.uy', ['https://tienda.lestido.com.uy/'], 'generic-html'),
  plannedSite('warnes', 'Warnes', 'warnes.com.uy', ['https://warnes.com.uy/'], 'generic-html'),
  existingSite({
    id: 'repuestosavenida',
    label: 'Repuestos Avenida',
    hostname: 'repuestosavenida.com.uy',
    seedUrls: ['https://repuestosavenida.com.uy/tienda/'],
    platform: 'woocommerce',
    productUrlPatterns: [/\/producto\/[^/?#]+\/?$/i],
    categoryUrlPatterns: [/\/(?:tienda|categoria-de-productos)(?:\/|\?|$)/i],
    paginationStrategy: { type: 'next-link', selector: 'a.next.page-numbers[href], a[rel="next"]', maxPages: 500 },
    requestDelay: 500,
  }),
  existingSite({
    id: 'gebamotors',
    label: 'Geba Motors',
    hostname: 'gebamotors.com.uy',
    seedUrls: ['https://gebamotors.com.uy/shop/'],
    platform: 'woocommerce',
    productUrlPatterns: [/\/producto\/[^/?#]+\/?$/i],
    categoryUrlPatterns: [/\/(?:shop|Categoria|categoria|product-category)(?:\/|\?|$)/i],
    paginationStrategy: {
      type: 'next-link',
      selector: 'a.next.page-numbers[href], a[rel="next"]',
      maxPages: 100,
    },
    requestDelay: 500,
  }),
  existingSite({
    id: 'diegoradiadores',
    label: 'Diego Radiadores',
    hostname: 'diegoradiadores.com.uy',
    seedUrls: ['https://diegoradiadores.com.uy/tienda/'],
    platform: 'woocommerce',
    productUrlPatterns: [/\/producto\/[^/?#]+\/?$/i],
    categoryUrlPatterns: [/\/(?:tienda|categoria-producto|product-category)(?:\/|\?|$)/i],
    paginationStrategy: { type: 'next-link', selector: 'a.next.page-numbers[href], a.wp-block-query-pagination-next[href], a[rel="next"]', maxPages: 300 },
    requestDelay: 500,
  }),
  existingSite({
    id: 'leoradiadores',
    label: 'Leo Radiadores',
    hostname: 'leoradiadores.com.uy',
    seedUrls: ['https://www.leoradiadores.com.uy/collections/all'],
    platform: 'shopify',
    productUrlPatterns: [/\/products\/[^/?#]+\/?$/i],
    categoryUrlPatterns: [/\/collections\//i],
    paginationStrategy: { type: 'page-param', param: 'page', start: 1, maxPages: 300 },
    requestDelay: 250,
  }),
  existingSite({
    id: 'autopartesgil',
    label: 'Autopartes Gil',
    hostname: 'autopartesgil.com',
    seedUrls: ['https://autopartesgil.com/productos/'],
    platform: 'woocommerce',
    productUrlPatterns: [/\/producto\/[^/?#]+\/?$/i],
    categoryUrlPatterns: [/\/(?:productos|tienda|categoria-producto)(?:\/|\?|$)/i],
    paginationStrategy: { type: 'next-link', selector: 'a.next.page-numbers[href], a[rel="next"]', maxPages: 2000 },
    requestDelay: 500,
  }),
  plannedSite('salvadorlivio', 'Salvador Livio', 'salvadorlivio.com.uy', ['https://salvadorlivio.com.uy/'], 'generic-html'),
  plannedSite('tnrepuestos', 'TN Repuestos', 'tnrepuestos.com.uy', ['https://tnrepuestos.com.uy/'], 'generic-html'),
  plannedSite('penasrepuestos', 'Penas Repuestos', 'penasrepuestos.com', ['https://penasrepuestos.com/'], 'generic-html'),
  plannedSite('euromotors', 'Euromotors', 'euromotors.com.uy', ['https://euromotors.com.uy/'], 'generic-html'),
  existingSite({
    id: 'autopartesmagallanes',
    label: 'Autopartes Magallanes',
    hostname: 'autopartesmagallanes.uy',
    seedUrls: ['https://autopartesmagallanes.uy/products/'],
    platform: 'woocommerce',
    productUrlPatterns: [
      // Match URLs with -ref- or ref- pattern, but exclude archive/vehicle pages
      // Exclude: /para-desarmar/, /restos/ (these are archive pages)
      // Include: all other categories with -ref- or ref- in URL slug
      /^(?!.*(?:\/repuestos-de(?:-|\/)|\/restos\/repuestos-de-para-desarmar\/)).*\/[^/?#]*-ref-[a-z0-9]+(?:-[a-z0-9]+)*\/?$/i,
      /^(?!.*(?:\/repuestos-de(?:-|\/)|\/restos\/repuestos-de-para-desarmar\/)).*\/[^/?#]*ref-[a-z0-9]+(?:-[a-z0-9]+)*\/?$/i,
    ],
    categoryUrlPatterns: [/\/(?:products|product-category|para-desarmar\/repuestos-de|restos\/repuestos-de-para-desarmar)(?:\/|\?|$)/i, /\/repuestos-de(?:-|\/|$)/i],
    paginationStrategy: { type: 'next-link', selector: 'a.next.page-numbers[href], a[rel="next"]', maxPages: 500 },
    requestDelay: 750,
  }),
  {
    ...plannedSite('mercado-libre-uy', 'Mercado Libre Uruguay', 'api.mercadolibre.com', ['https://api.mercadolibre.com/sites/MLU/search'], 'mercado-libre-api'),
    authentication: {
      type: 'oauth',
      clientIdEnv: 'MERCADO_LIBRE_CLIENT_ID',
      clientSecretEnv: 'MERCADO_LIBRE_CLIENT_SECRET',
      refreshTokenEnv: 'MERCADO_LIBRE_REFRESH_TOKEN',
      scopes: ['read'],
    },
  },
  ...GENERATED_CATALOG_SITES,
];

export function getCatalogSite(id: string): CatalogSiteConfig | undefined {
  return CATALOG_SITES.find((site) => site.id === id);
}

export function listEnabledCatalogSites(): CatalogSiteConfig[] {
  return CATALOG_SITES.filter((site) => site.enabled);
}

export function normalizeCatalogUrl(value: string, baseUrl?: string): string | undefined {
  try {
    const url = new URL(value, baseUrl);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    return /^https?:$/i.test(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function existingSite(config: Partial<CatalogSiteConfig> & Pick<CatalogSiteConfig, 'id' | 'label' | 'hostname' | 'seedUrls' | 'productUrlPatterns' | 'categoryUrlPatterns'>): CatalogSiteConfig {
  return {
    platform: 'generic-html',
    authentication: noAuth,
    paginationStrategy: defaultPagination,
    priceLocale: 'es-UY',
    preserveOutOfStock: true,
    concurrency: 2,
    requestDelay: 250,
    enabled: true,
    ...config,
  };
}

function plannedSite(
  id: string,
  label: string,
  hostname: string,
  seedUrls: string[],
  platform: CatalogSiteConfig['platform'],
): CatalogSiteConfig {
  return {
    id,
    label,
    hostname,
    seedUrls,
    platform,
    authentication: noAuth,
    productUrlPatterns: [/\/(?:producto|product|articulo|catalogo|repuesto)[^?#]+/i],
    categoryUrlPatterns: [/\/(?:productos|products|categoria|category|catalogo|shop|tienda)(?:\/|\?|$)/i],
    paginationStrategy: defaultPagination,
    priceLocale: 'es-UY',
    preserveOutOfStock: true,
    concurrency: 2,
    requestDelay: 500,
    enabled: false,
  };
}
