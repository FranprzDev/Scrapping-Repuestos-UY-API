import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsUrl, Max, Min } from 'class-validator';

export const DEFAULT_CATALOG_SITES = [
  'https://taxitor.uy/articulos/filtro/1/-/-/',
  'https://acesur.uy/escritorio/ofertas/INTERNET',
  'https://www.chaparei.com/productos/?m=171',
  'https://www.selvir.com.uy/product-category/carroceria/',
] as const;

export class CatalogScrapeRequestDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @IsUrl({}, { each: true })
  urls?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxPagesPerSite?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxProductsPerSite?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  siteConcurrency?: number;
}

export class SingleSiteCatalogScrapeRequestDto {
  @IsUrl()
  url!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxPages?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxProducts?: number;
}
