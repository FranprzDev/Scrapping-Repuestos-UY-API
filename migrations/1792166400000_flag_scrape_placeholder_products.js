/**
 * Mark rows created from catalog UI placeholders rather than product cards.
 * The rows remain recoverable; inventory queries hide only this explicit flag.
 */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE scraping_inventory
    SET product = product || '{"catalogQuality":"placeholder"}'::jsonb,
        updated_at = NOW()
    WHERE regexp_replace(
      translate(lower(coalesce(product->>'productName', '')), 'áéíóúüñ', 'aeiouun'),
      '[^a-z0-9]', '', 'g'
    ) IN (
      'verdetalle',
      'yourconnectionneedstobeverifiedbeforeyoucanproceed',
      'listadearticulos',
      'kitsdearticulos'
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE scraping_inventory
    SET product = product - 'catalogQuality'
    WHERE product->>'catalogQuality' = 'placeholder';
  `);
};

