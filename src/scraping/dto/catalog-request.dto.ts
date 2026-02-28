import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsUrl, Max, Min } from 'class-validator';

export const DEFAULT_CATALOG_SITES = [
  'https://acesur.uy/escritorio/home',
  'https://www.chaparei.com/',
  'http://www.centrorepuestos.com.uy',
  'https://www.selvir.com.uy/productos/',
  'https://www.feyvi.com.uy/',
  'https://repuestos.uy/',
  'https://www.tnrepuestos.com.uy/inicio',
  'https://www.todobaterias.com.uy/',
  'https://www.familcar.com',
  'https://repuestosavenida.com.uy/',
  'https://www.multishop.com.uy/',
  'https://www.garage1600.com.uy/',
  'https://taxitor.uy/',
  'https://viatons.com.uy/',
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
  @Max(200)
  maxPagesPerSite?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxProductsPerSite?: number;
}
