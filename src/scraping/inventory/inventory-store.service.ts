import { Injectable } from '@nestjs/common';
import { ProductRecord } from '../interfaces/scraping.types';

export interface StoredProduct extends ProductRecord {
  id: string;
  site: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

@Injectable()
export class InventoryStoreService {
  private readonly inventory = new Map<string, StoredProduct>();

  upsertSiteProducts(site: string, products: ProductRecord[], runAt: string) {
    let created = 0;
    let updated = 0;

    for (const product of products) {
      const key = buildProductKey(site, product);
      if (!key) {
        continue;
      }

      const existing = this.inventory.get(key);
      if (!existing) {
        const now = runAt;
        this.inventory.set(key, {
          ...product,
          id: key,
          site,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          stock: product.stock,
          availability: product.availability,
        });
        created += 1;
        continue;
      }

      const merged: StoredProduct = {
        ...existing,
        ...product,
        site,
        updatedAt: runAt,
        lastSeenAt: runAt,
        stock: product.stock ?? existing.stock,
        availability: product.availability ?? existing.availability,
      };

      this.inventory.set(key, merged);
      updated += 1;
    }

    return {
      created,
      updated,
      totalForSite: this.getBySite(site).length,
    };
  }

  getAll(): StoredProduct[] {
    return Array.from(this.inventory.values());
  }

  getBySite(site: string): StoredProduct[] {
    return this.getAll().filter((product) => product.site === site);
  }
}

function buildProductKey(site: string, product: ProductRecord): string | undefined {
  const sourceUrl = normalizeKeyPart(product.sourceUrl);
  if (sourceUrl) {
    return `${site}|url|${sourceUrl}`;
  }

  const sku = normalizeKeyPart(product.sku);
  if (sku) {
    return `${site}|sku|${sku}`;
  }

  const productName = normalizeKeyPart(product.productName);
  if (!productName) {
    return undefined;
  }

  const brand = normalizeKeyPart(product.brand) ?? 'no-brand';
  return `${site}|name|${productName}|${brand}`;
}

function normalizeKeyPart(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}
