import {
  IsBoolean,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  Min,
} from 'class-validator';

export const SCRAPE_FORMATS = ['html', 'links', 'products'] as const;

export class ScrapeRequestDto {
  @IsUrl({ require_tld: true })
  url!: string;

  @IsOptional()
  @IsArray()
  @IsIn(SCRAPE_FORMATS, { each: true })
  formats?: (typeof SCRAPE_FORMATS)[number][];

  @IsOptional()
  @IsBoolean()
  onlyMainContent?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(15000)
  waitFor?: number;
}

export class CrawlRequestDto extends ScrapeRequestDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  includePaths?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludePaths?: string[];
}

export class ExtractRequestDto {
  @IsUrl({ require_tld: true })
  url!: string;

  @IsString()
  prompt!: string;

  @IsOptional()
  @IsObject()
  schema?: Record<string, unknown>;
}

export class DomainProviderConfigDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  async?: 'true' | 'false';

  @IsOptional()
  @IsIn(['domain', 'playwright', 'custom'])
  provider?: 'domain' | 'playwright' | 'custom';
}

export class JobIdParamDto {
  @IsUUID()
  id!: string;
}
