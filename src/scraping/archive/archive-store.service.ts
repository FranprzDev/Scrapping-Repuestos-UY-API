import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ProductRecord } from '../interfaces/scraping.types';
import { canonicalSiteKey } from '../domain/site-key';

@Injectable()
export class ArchiveStoreService {
  private readonly outputRoot = path.join(process.cwd(), 'output');

  async saveSiteCatalog(site: string, products: ProductRecord[], runAt: string, trace?: Record<string, unknown>) {
    const siteKey = canonicalSiteKey(site);
    const catalogDir = path.join(this.outputRoot, 'catalog');

    await mkdir(catalogDir, { recursive: true });

    const payload = {
      site,
      runAt,
      total: products.length,
      trace,
      products,
    };

    const outputPath = path.join(catalogDir, `${siteKey}.json`);
    await writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');

    return {
      outputPath,
      total: products.length,
      products,
    };
  }

  async clearAll(): Promise<void> {
    await rm(path.join(this.outputRoot, 'catalog'), { recursive: true, force: true });
  }
}
