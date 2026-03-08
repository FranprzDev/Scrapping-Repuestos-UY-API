import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsUrl, Max, Min } from 'class-validator';

export const DEFAULT_CATALOG_SITES = [
  'https://www.chaparei.com/',
  'https://www.selvir.com.uy/productos/',
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
  @Max(5000)
  maxPagesPerSite?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20000)
  maxProductsPerSite?: number;
}

export class SingleSiteCatalogScrapeRequestDto {
  @IsUrl()
  url!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  maxPages?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20000)
  maxProducts?: number;
}
