import { IsArray, IsInt, IsOptional, IsUrl, Min } from 'class-validator';

export const BASE_CATALOG_SITES = [
  'https://taxitor.uy/articulos/filtro/1/-/-/',
  'https://acesur.uy/escritorio/ofertas/INTERNET',
  'https://www.chaparei.com/productos/?m=171',
  'https://www.selvir.com.uy/product-category/carroceria/',
] as const;

export const FEYVI_CATALOG_SITES = [
  'https://www.feyvi.com.uy/repuestos/acabamiento-interior/',
  'https://www.feyvi.com.uy/repuestos/acabamiento-exterior/',
  'https://www.feyvi.com.uy/repuestos/carroceria/',
  'https://www.feyvi.com.uy/repuestos/eje-trasero/',
  'https://www.feyvi.com.uy/repuestos/cristales/',
  'https://www.feyvi.com.uy/repuestos/accesorios/',
  'https://www.feyvi.com.uy/repuestos/enfriamiento-y-lubricacion/',
  'https://www.feyvi.com.uy/repuestos/kits-mantenimiento/',
  'https://www.feyvi.com.uy/repuestos/instrumentos-audio-a-a-y-l-parabrisas/',
  'https://www.feyvi.com.uy/repuestos/sistema-de-frenos/',
  'https://www.feyvi.com.uy/repuestos/sistema-electrico-de-la-carroceria-es/',
  'https://www.feyvi.com.uy/repuestos/herramientas/',
  'https://www.feyvi.com.uy/repuestos/alimentacion-admision-de-aire-y-escape-es/',
  'https://www.feyvi.com.uy/repuestos/arbol-de-transmision/',
  'https://www.feyvi.com.uy/repuestos/mantenimiento-y-estetica-automotriz/',
  'https://www.feyvi.com.uy/repuestos/motor-y-embrague/',
  'https://www.feyvi.com.uy/repuestos/paragolpes-y-suspension-trasera/',
  'https://www.feyvi.com.uy/repuestos/transmision-caja-cambios/',
  'https://www.feyvi.com.uy/repuestos/sistema-electrico-motor-y-transmision-es/',
  'https://www.feyvi.com.uy/repuestos/suspension-delantera-direccion-y-llantas-es/',
] as const;

export const DEFAULT_CATALOG_SITES = [...BASE_CATALOG_SITES, ...FEYVI_CATALOG_SITES] as const;

export class CatalogScrapeRequestDto {
  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  urls?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPagesPerSite?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxProductsPerSite?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  siteConcurrency?: number;
}

export class SingleSiteCatalogScrapeRequestDto {
  @IsUrl()
  url!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPages?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxProducts?: number;
}

export class PurgeSiteDataRequestDto {
  @IsUrl()
  site!: string;
}
