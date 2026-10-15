exports.up = (pgm) => pgm.sql(`
  ALTER TABLE image_jobs ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  CREATE INDEX image_jobs_ready_idx ON image_jobs(next_attempt_at, created_at, id)
    WHERE status IN ('pending', 'retry_pending');
  CREATE INDEX image_jobs_expired_idx ON image_jobs(claimed_at, id) WHERE status = 'processing';
  WITH candidates AS (
    SELECT DISTINCT i.id, i.site, BTRIM(u.url) AS url
    FROM scraping_inventory i
    CROSS JOIN LATERAL jsonb_array_elements_text(
      (CASE WHEN jsonb_typeof(i.product->'imageUrls') = 'array'
        THEN i.product->'imageUrls' ELSE '[]'::jsonb END)
      || jsonb_build_array(i.product->>'imageUrl')
    ) AS u(url)
    WHERE BTRIM(u.url) ~* '^https?://'
      AND BTRIM(u.url) !~* '/api/image-assets/'
  )
  INSERT INTO image_jobs (id, inventory_id, site, product_id, image_url)
    SELECT md5(jsonb_build_array('all-provider-images-v1', id, url)::text)::uuid,
      id, site, id, url FROM candidates
    ON CONFLICT (inventory_id, image_url) DO NOTHING;
`);

exports.down = (pgm) => pgm.sql(`
  -- Preserve downloaded assets and jobs already attempted.
  DELETE FROM image_jobs j
    WHERE j.id = md5(jsonb_build_array('all-provider-images-v1', j.inventory_id, j.image_url)::text)::uuid
      AND j.status = 'pending' AND j.attempts = 0
      AND NOT EXISTS (SELECT 1 FROM image_assets a WHERE a.image_job_id = j.id);
  DROP INDEX image_jobs_ready_idx;
  DROP INDEX image_jobs_expired_idx;
  ALTER TABLE image_jobs DROP COLUMN next_attempt_at;
`);
