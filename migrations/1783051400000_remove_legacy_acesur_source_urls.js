/**
 * Remove Acesur inventory rows that point to the old mobile-app listing URL.
 * The current Acesur adapter stores /detalle-producto/?articulo=<SKU> instead.
 */
exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM scraping_inventory
    WHERE source_url LIKE 'https://acesur.uy/escritorio/ofertas/INTERNET?codigo=%';
  `);
};

exports.down = () => {
  // Deleted inventory rows cannot be reconstructed without a backup.
};
