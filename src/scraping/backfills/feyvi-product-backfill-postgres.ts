import { ProductRecord } from '../interfaces/scraping.types';
import { PostgresService } from '../jobs/postgres.service';
import { FeyviBackfillRow, FeyviBackfillStore } from './feyvi-product-backfill';

type CandidateRow = {
  id: string;
  source_url: string;
  product: ProductRecord;
};

export class PostgresFeyviProductBackfillStore implements FeyviBackfillStore {
  constructor(private readonly postgresService: PostgresService) {}

  async findCandidates(limit?: number): Promise<FeyviBackfillRow[]> {
    const params: unknown[] = [];
    const limitClause = typeof limit === 'number' ? 'LIMIT $1' : '';
    if (typeof limit === 'number') {
      params.push(limit);
    }

    const result = await this.postgresService.query<CandidateRow>(
      `
      SELECT id, source_url, product
      FROM scraping_inventory
      WHERE source_url ~* '^https?://(www\\.)?feyvi\\.com\\.uy/repuestos/([^/]+/){2}[^/?#]+/?$'
      ORDER BY updated_at DESC, source_url ASC
      ${limitClause}
      `,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id,
      sourceUrl: row.source_url,
      product: row.product,
    }));
  }

  async updateProductFields(id: string, product: ProductRecord): Promise<void> {
    await this.postgresService.query(
      `
      UPDATE scraping_inventory
      SET product = product || jsonb_strip_nulls(jsonb_build_object(
            'imageUrl', $2::text,
            'imageUrls', to_jsonb($3::text[]),
            'brand', $4::text,
            'compatibleBrands', to_jsonb($5::text[]),
            'compatibleModels', to_jsonb($6::text[]),
            'compatibleVehicles', to_jsonb($7::text[]),
            'compatibleVersions', to_jsonb($8::text[])
          )),
          updated_at = NOW()
      WHERE id = $1
      `,
      [
        id,
        product.imageUrl ?? null,
        product.imageUrls ?? null,
        product.brand ?? null,
        product.compatibleBrands ?? null,
        product.compatibleModels ?? null,
        product.compatibleVehicles ?? null,
        product.compatibleVersions ?? null,
      ],
    );
  }
}
