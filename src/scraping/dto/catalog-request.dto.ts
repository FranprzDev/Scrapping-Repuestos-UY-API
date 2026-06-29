import { IsArray, IsInt, IsOptional, IsUrl, Min } from 'class-validator';

export const BASE_CATALOG_SITES = [
  'https://taxitor.uy/articulos/filtro/1/-/-/',
  'https://acesur.uy/escritorio/ofertas/INTERNET',
  'https://www.chaparei.com/productos/',
] as const;

export const GRFRENOS_CATALOG_SITES = [
  'https://www.grfrenos.uy/home/',
] as const;

export const SELVIR_CATALOG_SITES = [
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

export const DEFAULT_CATALOG_SITES = [...BASE_CATALOG_SITES, ...GRFRENOS_CATALOG_SITES, ...SELVIR_CATALOG_SITES, ...FEYVI_CATALOG_SITES] as const;

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
