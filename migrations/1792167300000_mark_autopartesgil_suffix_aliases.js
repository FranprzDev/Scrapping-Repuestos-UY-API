/*
 * Hide the remaining Autopartes Gil aliases created by appending a numeric
 * suffix to an already existing product URL (for example, `...-3-2`).
 *
 * This is separate from the first migration because a short numeric product
 * identifier can itself look like a suffix. Here we only mark a row when its
 * URL is the canonical URL plus a numeric suffix chain and its scraped
 * identity fields are identical.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS scraping_inventory_dedup_aliases (
      inventory_id TEXT PRIMARY KEY
        REFERENCES scraping_inventory(id) ON DELETE CASCADE,
      canonical_id TEXT NOT NULL
        REFERENCES scraping_inventory(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    WITH candidate_rows AS (
      SELECT
        i.id,
        i.updated_at,
        lower(regexp_replace(BTRIM(i.source_url), '/+$', '')) AS normalized_source_url,
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
        AND i.dedup_canonical_id IS NULL
    ),
    pairs AS (
      SELECT
        duplicate.id AS inventory_id,
        canonical.id AS canonical_id,
        ROW_NUMBER() OVER (
          PARTITION BY duplicate.id
          ORDER BY LENGTH(canonical.normalized_source_url), canonical.updated_at DESC, canonical.id ASC
        ) AS rank
      FROM candidate_rows duplicate
      JOIN candidate_rows canonical
        ON canonical.id <> duplicate.id
       AND canonical.product_key = duplicate.product_key
       AND LEFT(duplicate.normalized_source_url, LENGTH(canonical.normalized_source_url) + 1)
             = canonical.normalized_source_url || '-'
       AND SUBSTRING(duplicate.normalized_source_url FROM LENGTH(canonical.normalized_source_url) + 2)
             ~ '^[0-9]+(?:-[0-9]+)*$'
    )
    INSERT INTO scraping_inventory_dedup_aliases (inventory_id, canonical_id, reason)
    SELECT inventory_id, canonical_id, 'autopartesgil-suffix-alias'
    FROM pairs
    WHERE rank = 1
    ON CONFLICT (inventory_id) DO NOTHING;

    UPDATE scraping_inventory inventory
    SET dedup_canonical_id = aliases.canonical_id
    FROM scraping_inventory_dedup_aliases aliases
    WHERE inventory.id = aliases.inventory_id
      AND inventory.dedup_canonical_id IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE scraping_inventory inventory
    SET dedup_canonical_id = NULL
    FROM scraping_inventory_dedup_aliases aliases
    WHERE inventory.id = aliases.inventory_id
      AND inventory.dedup_canonical_id = aliases.canonical_id;

    DROP TABLE IF EXISTS scraping_inventory_dedup_aliases;
  `);
};
