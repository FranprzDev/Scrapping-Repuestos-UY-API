exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE image_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      inventory_id TEXT NOT NULL REFERENCES scraping_inventory(id) ON DELETE CASCADE,
      site TEXT NOT NULL,
      product_id TEXT NOT NULL,
      image_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','retry_pending','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (inventory_id, image_url)
    );
    CREATE INDEX image_jobs_claim_idx ON image_jobs(status, created_at);
    CREATE TABLE image_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      inventory_id TEXT NOT NULL REFERENCES scraping_inventory(id) ON DELETE CASCADE,
      image_job_id UUID NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL,
      bytes BIGINT NOT NULL CHECK (bytes > 0),
      sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (image_job_id),
      UNIQUE (inventory_id, source_url)
    );
  `);
};
exports.down = (pgm) => pgm.sql('DROP TABLE IF EXISTS image_assets; DROP TABLE IF EXISTS image_jobs;');
