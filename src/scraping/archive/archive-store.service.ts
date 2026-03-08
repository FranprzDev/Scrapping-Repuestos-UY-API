import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ProductRecord } from '../interfaces/scraping.types';

@Injectable()
export class ArchiveStoreService {
  private readonly outputRoot = path.join(process.cwd(), 'output');

  async saveSiteCatalog(site: string, products: ProductRecord[], runAt: string) {
    const hostname = safeHostname(site) ?? 'unknown-site';
    const catalogDir = path.join(this.outputRoot, 'catalog');
    const imageDir = path.join(this.outputRoot, 'images', hostname);

    await mkdir(catalogDir, { recursive: true });
    await mkdir(imageDir, { recursive: true });

    const productsWithImages: ProductRecord[] = [];

    for (const product of products) {
      let imagePath = product.imagePath;

      if (product.imageUrl) {
        imagePath = await this.downloadImage(product.imageUrl, imageDir, hostname, product.productName);
      }

      productsWithImages.push({
        ...product,
        imagePath,
      });
    }

    const payload = {
      site,
      runAt,
      total: productsWithImages.length,
      products: productsWithImages,
    };

    const outputPath = path.join(catalogDir, `${hostname}.json`);
    await writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');

    return {
      outputPath,
      total: productsWithImages.length,
      imagesSaved: productsWithImages.filter((product) => product.imagePath).length,
      products: productsWithImages,
    };
  }

  private async downloadImage(imageUrl: string, imageDir: string, hostname: string, productName?: string) {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        return undefined;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const extension = resolveExtension(imageUrl, response.headers.get('content-type'));
      const filename = `${slugify(productName ?? imageUrl).slice(0, 80) || 'image'}-${hashString(imageUrl)}.${extension}`;
      const outputPath = path.join(imageDir, filename);

      await writeFile(outputPath, buffer);
      return outputPath;
    } catch {
      return undefined;
    }
  }
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function resolveExtension(imageUrl: string, contentType: string | null): string {
  const fromUrl = path.extname(new URL(imageUrl).pathname).replace('.', '').toLowerCase();
  if (fromUrl && /^[a-z0-9]{2,5}$/.test(fromUrl)) {
    return fromUrl;
  }

  if (contentType?.includes('png')) return 'png';
  if (contentType?.includes('webp')) return 'webp';
  if (contentType?.includes('gif')) return 'gif';
  return 'jpg';
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function hashString(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16);
}
