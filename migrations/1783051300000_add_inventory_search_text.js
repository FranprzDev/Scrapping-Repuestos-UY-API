exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    ALTER TABLE scraping_inventory ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT '';

    UPDATE scraping_inventory
    SET search_text = regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(CONCAT_WS(
            ' ',
            product->>'productName',
            product->>'brand',
            product->>'category',
            product->>'description',
            product->>'compatibleVehicles',
            product->>'compatibleModels',
            product->>'compatibleVersions',
            product->>'compatibleBrands',
            product::text
          )),
          '[^[:alnum:]]+', ' ', 'g'
        ),
        '([[:alpha:]])\\1+', '\\1', 'g'
      ),
      '\\s+', ' ', 'g'
    )
    WHERE search_text = '';

    CREATE INDEX IF NOT EXISTS scraping_inventory_search_text_trgm_idx
      ON scraping_inventory USING GIN (search_text gin_trgm_ops);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS scraping_inventory_search_text_trgm_idx;
    ALTER TABLE scraping_inventory DROP COLUMN IF EXISTS search_text;
  `);
};
