import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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

export const FIRECRAWL_FORMATS = ['markdown', 'html', 'rawHtml', 'links', 'screenshot'] as const;

export class ScrapeRequestDto {
  @IsUrl({ require_tld: true })
  url!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsIn(FIRECRAWL_FORMATS, { each: true })
  formats?: (typeof FIRECRAWL_FORMATS)[number][];

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
  @ArrayMaxSize(25)
  @IsString({ each: true })
  includePaths?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
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
  @IsBoolean()
  async?: boolean;

  @IsOptional()
  @IsIn(['firecrawl', 'custom'])
  provider?: 'firecrawl' | 'custom';
}

export class JobIdParamDto {
  @IsUUID()
  id!: string;
}
