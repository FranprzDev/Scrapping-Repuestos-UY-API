/*
 * Hide only the confirmed Autopartes Gil clone pages from the inventory.
 *
 * The site publishes the same product repeatedly with a numeric suffix
 * appended to the WordPress slug (for example, `...-53548402-10`).  We only
 * mark rows when all scraped identity fields match and the product has no
 * SKU, so products with a real provider SKU or a different price remain
 * visible.  Rows are retained and can be restored by the down migration.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE scraping_inventory
      ADD COLUMN IF NOT EXISTS dedup_canonical_id TEXT NULL
      REFERENCES scraping_inventory(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS scraping_inventory_dedup_canonical_idx
      ON scraping_inventory(dedup_canonical_id)
      WHERE dedup_canonical_id IS NOT NULL;

    WITH candidate_rows AS (
      SELECT
        i.id,
        i.updated_at,
        i.source_url,
        regexp_replace(
          lower(regexp_replace(BTRIM(i.source_url), '/+$', '')),
          '-(?:[2-9]|1[0-9]|2[0-9]|30)$',
          ''
        ) AS clone_base_url,
        NULLIF(regexp_replace(lower(COALESCE(i.product->>'productName', '')), '[^[:alnum:]]', '', 'g'), '')
          || '|' || COALESCE(NULLIF(regexp_replace(lower(COALESCE(i.product->>'brand', '')), '[^[:alnum:]]', '', 'g'), ''), '')
          || '|' || COALESCE(NULLIF(regexp_replace(lower(COALESCE(i.product->>'price', '')), '[^[:alnum:],.]', '', 'g'), ''), '')
          || '|' || COALESCE(NULLIF(regexp_replace(lower(COALESCE(i.product->>'availability', '')), '[^[:alnum:]]', '', 'g'), ''), '')
          || '|' || COALESCE(NULLIF(regexp_replace(lower(COALESCE(i.product->>'imageUrl', '')), '[^[:alnum:]]', '', 'g'), ''), '')
          AS product_key
      FROM scraping_inventory i
      WHERE regexp_replace(
              split_part(replace(replace(lower(i.site), 'https://', ''), 'http://', ''), '/', 1),
              '^www\\.',
              ''
            ) = 'autopartesgil.com'
        AND NULLIF(BTRIM(COALESCE(i.product->>'sku', '')), '') IS NULL
        AND NULLIF(BTRIM(COALESCE(i.product->>'productName', '')), '') IS NOT NULL
        AND BTRIM(COALESCE(i.source_url, '')) <> ''
    ),
    ranked AS (
      SELECT
        id,
        FIRST_VALUE(id) OVER (
          PARTITION BY clone_base_url, product_key
          ORDER BY
            CASE WHEN lower(regexp_replace(BTRIM(source_url), '/+$', '')) = clone_base_url THEN 0 ELSE 1 END,
            updated_at DESC,
            id ASC
        ) AS canonical_id,
        COUNT(*) OVER (PARTITION BY clone_base_url, product_key) AS group_count
      FROM candidate_rows
    )
    UPDATE scraping_inventory inventory
    SET dedup_canonical_id = ranked.canonical_id
    FROM ranked
    WHERE inventory.id = ranked.id
      AND ranked.group_count > 1
      AND ranked.id <> ranked.canonical_id
      AND inventory.dedup_canonical_id IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE scraping_inventory
    SET dedup_canonical_id = NULL
    WHERE dedup_canonical_id IS NOT NULL;

    DROP INDEX IF EXISTS scraping_inventory_dedup_canonical_idx;
    ALTER TABLE scraping_inventory DROP COLUMN IF EXISTS dedup_canonical_id;
  `);
};
