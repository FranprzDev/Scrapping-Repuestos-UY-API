/**
 * Rebuild the materialized search text with the same accent-insensitive
 * normalization used by the API search parser. This makes legacy rows behave
 * the same as rows written after the relevance ranking is deployed.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS unaccent;

    UPDATE scraping_inventory
    SET search_text = regexp_replace(
      regexp_replace(
        lower(unaccent(CONCAT_WS(
          ' ',
          product->>'productName',
          product->>'sku',
          product->>'brand',
          product->>'category',
          product->>'description',
          product->>'compatibleVehicles',
          product->>'compatibleModels',
          product->>'compatibleVersions',
          product->>'compatibleBrands',
          product->'attributes'
        ))),
        '[^[:alnum:]]+', ' ', 'g'
      ),
      '\\s+', ' ', 'g'
    );
  `);
};

exports.down = () => {
  // The previous materialized values cannot be reconstructed losslessly.
};

