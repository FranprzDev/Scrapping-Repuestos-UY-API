import { ProductRecord } from '../interfaces/scraping.types';
import { PostgresService } from '../jobs/postgres.service';
import {
  REPUESTOS_AVENIDA_PRODUCT_URL_PREFIX,
  RepuestosAvenidaBackfillRow,
  RepuestosAvenidaBackfillStore,
} from './repuestosavenida-image-backfill';

type CandidateRow = {
  id: string;
  source_url: string;
  product: ProductRecord;
};

export class PostgresRepuestosAvenidaImageBackfillStore implements RepuestosAvenidaBackfillStore {
  constructor(private readonly postgresService: PostgresService) {}

  async findCandidates(limit?: number): Promise<RepuestosAvenidaBackfillRow[]> {
    const params: unknown[] = [REPUESTOS_AVENIDA_PRODUCT_URL_PREFIX];
    const limitClause = typeof limit === 'number' ? 'LIMIT $2' : '';
    if (typeof limit === 'number') {
      params.push(limit);
    }

    const result = await this.postgresService.query<CandidateRow>(
      `
      SELECT id, source_url, product
      FROM scraping_inventory
      WHERE source_url LIKE $1 || '%'
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

  async updateImages(id: string, product: ProductRecord): Promise<void> {
    await this.postgresService.query(
      `
      UPDATE scraping_inventory
      SET product = jsonb_set(
            jsonb_set(product - 'imageUrl' - 'imageUrls', '{imageUrl}', to_jsonb($2::text), true),
            '{imageUrls}',
            to_jsonb($3::text[]),
            true
          ),
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, product.imageUrl ?? null, product.imageUrls ?? []],
    );
  }
}
