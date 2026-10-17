/**
 * Remove known instructional descriptions imported from Repuestos Avenida.
 * The previous JSON and search value are retained so the migration is
 * reversible without deleting any inventory row.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS scraping_inventory_description_cleanup (
      inventory_id TEXT PRIMARY KEY REFERENCES scraping_inventory(id) ON DELETE CASCADE,
      before_product JSONB NOT NULL,
      before_search_text TEXT NOT NULL,
      before_updated_at TIMESTAMPTZ NOT NULL,
      cleaned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO scraping_inventory_description_cleanup (
      inventory_id, before_product, before_search_text, before_updated_at
    )
    SELECT id, product, search_text, updated_at
    FROM scraping_inventory
    WHERE regexp_replace(
      split_part(replace(replace(lower(site), 'https://', ''), 'http://', ''), '/', 1),
      '^www\\.', ''
    ) = 'repuestosavenida.com.uy'
      AND product ? 'description'
      AND (
        lower(product->>'description') ~ 'aqu[ií] va una descripci[oó]n t[eé]cnica del producto'
        OR lower(product->>'description') ~ 'puedes usar este formato como plantilla'
        OR lower(product->>'description') ~ 'si quieres,? te la dejo en formato plantilla'
      )
    ON CONFLICT (inventory_id) DO NOTHING;

    UPDATE scraping_inventory inventory
    SET product = inventory.product - 'description',
        search_text = trim(regexp_replace(
          regexp_replace(lower(concat_ws(' ',
            inventory.product->>'productName',
            inventory.product->>'sku',
            inventory.product->>'brand',
            inventory.product->>'category',
            inventory.product->>'compatibleVehicles',
            inventory.product->>'compatibleModels',
            inventory.product->>'compatibleVersions',
            inventory.product->>'compatibleBrands',
            inventory.product->>'attributes'
          )), '[^a-z0-9]+', ' ', 'g'),
          '([a-z])\\1+', '\\1', 'g'
        )),
        updated_at = NOW()
    WHERE inventory.id IN (SELECT inventory_id FROM scraping_inventory_description_cleanup);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE scraping_inventory inventory
    SET product = cleanup.before_product,
        search_text = cleanup.before_search_text,
        updated_at = cleanup.before_updated_at
    FROM scraping_inventory_description_cleanup cleanup
    WHERE inventory.id = cleanup.inventory_id
      AND NOT (inventory.product ? 'description');

    DROP TABLE IF EXISTS scraping_inventory_description_cleanup;
  `);
};

