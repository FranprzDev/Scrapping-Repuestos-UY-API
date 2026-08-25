exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE image_jobs
      ADD COLUMN upload_storage_key TEXT,
      ADD COLUMN upload_bytes BIGINT,
      ADD COLUMN upload_sha256 TEXT,
      ADD COLUMN upload_content_type TEXT,
      ADD COLUMN upload_started_at TIMESTAMPTZ;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE image_jobs
      DROP COLUMN IF EXISTS upload_storage_key,
      DROP COLUMN IF EXISTS upload_bytes,
      DROP COLUMN IF EXISTS upload_sha256,
      DROP COLUMN IF EXISTS upload_content_type,
      DROP COLUMN IF EXISTS upload_started_at;
  `);
};
