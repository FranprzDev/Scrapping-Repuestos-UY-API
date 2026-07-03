exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS scraping_inventory (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      product JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    LOCK TABLE scraping_inventory IN SHARE ROW EXCLUSIVE MODE;
    ALTER TABLE scraping_inventory ADD COLUMN IF NOT EXISTS source_url TEXT NULL;

    DELETE FROM scraping_inventory
    WHERE lower(COALESCE(product->>'sourceUrl', '')) ~ '[?&]dispatch=product_features\\.add_product(&|$)'
       OR BTRIM(COALESCE(product->>'sourceUrl', '')) = ''
       OR (
         lower(product->>'sourceUrl') ~ '^https?://(www\\.)?feyvi\\.com\\.uy/'
         AND lower(product->>'sourceUrl') !~ '^https?://(www\\.)?feyvi\\.com\\.uy/repuestos/([^/]+/){2}[^/?#]+/?$'
       );

    UPDATE scraping_inventory
    SET source_url = lower(
      regexp_replace(
        regexp_replace(
          split_part(BTRIM(product->>'sourceUrl'), '#', 1),
          '^(https?://)www\\.',
          '\\1',
          'i'
        ),
        '/+$',
        ''
      )
    )
    WHERE source_url IS NULL OR source_url = '';

    DELETE FROM scraping_inventory duplicate
    USING scraping_inventory keeper
    WHERE duplicate.source_url = keeper.source_url
      AND (
        duplicate.updated_at < keeper.updated_at
        OR (duplicate.updated_at = keeper.updated_at AND duplicate.id > keeper.id)
      );

    ALTER TABLE scraping_inventory ALTER COLUMN source_url SET NOT NULL;
    CREATE UNIQUE INDEX scraping_inventory_source_url_unique_idx ON scraping_inventory(source_url);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS scraping_inventory_source_url_unique_idx;
    ALTER TABLE scraping_inventory DROP COLUMN IF EXISTS source_url;
  `);
};
