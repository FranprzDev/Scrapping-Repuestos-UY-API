exports.up = (pgm) => pgm.sql(`
  CREATE TABLE IF NOT EXISTS feyvi_recovery_results (
    run_id TEXT NOT NULL,
    inventory_id TEXT NOT NULL,
    apply BOOLEAN NOT NULL,
    result JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, inventory_id, apply)
  );
  CREATE TABLE IF NOT EXISTS feyvi_recovery_events (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    inventory_id TEXT NOT NULL,
    result JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS feyvi_recovery_backups (
    run_id TEXT NOT NULL,
    inventory_id TEXT NOT NULL,
    before_product JSONB NOT NULL,
    after_product JSONB NOT NULL,
    before_search_text TEXT NOT NULL,
    before_brand_relations JSONB NOT NULL,
    before_updated_at TIMESTAMPTZ NOT NULL,
    after_brand_relations JSONB,
    backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, inventory_id)
  );

  CREATE FUNCTION feyvi_merge_product(previous JSONB, incoming JSONB) RETURNS JSONB
  LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE merged JSONB; field TEXT; values_json JSONB;
  BEGIN
    SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO incoming
    FROM jsonb_each(incoming)
    WHERE value NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb);
    -- Preserve historical data when a sync has no valid monetary value.
    IF NOT COALESCE(incoming->>'price' ~ '^([0-9]{1,3}(,[0-9]{3})+([.][0-9]{1,2})?|[0-9]{1,3}([.][0-9]{3})+(,[0-9]{1,2})?|[0-9]+([.,][0-9]{1,2})?)$', false)
      OR COALESCE(regexp_replace(incoming->>'price', '[.,]', '', 'g'), '0') ~ '^0+$' THEN
      incoming := incoming - 'price' - 'currency';
    END IF;
    merged := previous || incoming;
    FOREACH field IN ARRAY ARRAY['compatibleBrands','compatibleModels','compatibleVehicles','compatibleVersions'] LOOP
      SELECT jsonb_agg(value ORDER BY value) INTO values_json
      FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(previous->field) = 'array' THEN previous->field ELSE '[]'::jsonb END
        || CASE WHEN jsonb_typeof(incoming->field) = 'array' THEN incoming->field ELSE '[]'::jsonb END
      )) values_table;
      IF values_json IS NOT NULL THEN merged := jsonb_set(merged, ARRAY[field], values_json); END IF;
    END LOOP;
    -- Relayed/local photographs and their metadata must stay together.
    IF previous->>'imageStatus' = 'completed' OR (previous->>'imageUrl' ~ '^https?://'
      AND previous->>'imageUrl' !~* '(logo|favicon|placeholder|no-image|sin-imagen|loader|sprite|banner|promo)') THEN
      FOREACH field IN ARRAY ARRAY['imageUrl','imageUrls','sourceImageUrl','imageStatus','imagePath'] LOOP
        IF previous ? field THEN merged := jsonb_set(merged, ARRAY[field], previous->field); END IF;
      END LOOP;
    END IF;
    RETURN merged;
  END $$;

  CREATE FUNCTION feyvi_search_text(product JSONB) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $$
    SELECT trim(regexp_replace(regexp_replace(lower(concat_ws(' ',
      product->>'productName', product->>'sku', product->>'brand', product->>'category',
      product->>'description', product->>'compatibleVehicles', product->>'compatibleModels',
      product->>'compatibleVersions', product->>'compatibleBrands', product->>'attributes'
    )), '[^a-z0-9]+', ' ', 'g'), '([a-z])\\1+', '\\1', 'g'));
  $$;

  CREATE FUNCTION feyvi_apply_patch(target_id TEXT, expected JSONB, replacement JSONB, recovery_run TEXT)
  RETURNS BOOLEAN LANGUAGE plpgsql AS $$
  DECLARE current_row scraping_inventory%ROWTYPE; next_product JSONB; relations JSONB;
  BEGIN
    IF recovery_run IS NULL OR recovery_run = '' THEN RAISE EXCEPTION 'run_id required'; END IF;
    SELECT * INTO current_row FROM scraping_inventory WHERE id = target_id FOR UPDATE;
    IF NOT FOUND OR current_row.source_url !~* '^https?://(www\\.)?feyvi\\.com\\.uy/repuestos/([^/]+/){2}[^/?#]+/?$' THEN
      RAISE EXCEPTION 'not a Feyvi detail row';
    END IF;
    IF current_row.product IS DISTINCT FROM expected THEN RAISE EXCEPTION 'concurrent_product_change'; END IF;
    SELECT COALESCE(jsonb_object_agg(key,value), '{}'::jsonb) INTO replacement FROM jsonb_each(replacement)
    WHERE key IN ('price','currency','sku','productName','description','availability','imageUrl','imageUrls','brand',
                 'compatibleBrands','compatibleModels','compatibleVehicles','compatibleVersions');
    next_product := feyvi_merge_product(current_row.product, replacement);
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.brand_id), '[]'::jsonb) INTO relations
    FROM scraping_inventory_vehicle_brands r WHERE inventory_id = target_id;
    INSERT INTO feyvi_recovery_backups(run_id,inventory_id,before_product,after_product,before_search_text,before_brand_relations,before_updated_at)
    VALUES(recovery_run,target_id,current_row.product,next_product,current_row.search_text,relations,current_row.updated_at);
    UPDATE scraping_inventory SET product = next_product, search_text = feyvi_search_text(next_product), updated_at = NOW()
    WHERE id = target_id;
    INSERT INTO scraping_inventory_vehicle_brands(inventory_id,brand_id,confidence,evidence)
    SELECT target_id,b.id,'explicit',b.label FROM vehicle_brands b
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(next_product->'compatibleBrands') = 'array' THEN next_product->'compatibleBrands' ELSE '[]'::jsonb END) v
                  WHERE lower(v.value) = lower(b.label))
    ON CONFLICT (inventory_id,brand_id) DO UPDATE SET confidence = 'explicit', evidence = EXCLUDED.evidence;
    UPDATE feyvi_recovery_backups SET after_brand_relations = (
      SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.brand_id), '[]'::jsonb)
      FROM scraping_inventory_vehicle_brands r WHERE inventory_id = target_id
    ) WHERE run_id = recovery_run AND inventory_id = target_id;
    RETURN true;
  END $$;

  CREATE FUNCTION feyvi_restore_run(recovery_run TEXT) RETURNS INTEGER LANGUAGE plpgsql AS $$
  DECLARE backup feyvi_recovery_backups%ROWTYPE; current_product JSONB; restored INTEGER := 0;
  BEGIN
    FOR backup IN SELECT * FROM feyvi_recovery_backups WHERE run_id = recovery_run ORDER BY inventory_id LOOP
      SELECT product INTO current_product FROM scraping_inventory WHERE id = backup.inventory_id FOR UPDATE;
      IF NOT FOUND OR current_product IS DISTINCT FROM backup.after_product THEN
        RAISE EXCEPTION 'rollback blocked by concurrent change: %', backup.inventory_id;
      END IF;
      IF (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.brand_id), '[]'::jsonb)
          FROM scraping_inventory_vehicle_brands r WHERE inventory_id = backup.inventory_id)
          IS DISTINCT FROM backup.after_brand_relations THEN
        RAISE EXCEPTION 'rollback blocked by concurrent brand relation change: %', backup.inventory_id;
      END IF;
      UPDATE scraping_inventory SET product = backup.before_product, search_text = backup.before_search_text,
        updated_at = backup.before_updated_at WHERE id = backup.inventory_id;
      DELETE FROM scraping_inventory_vehicle_brands WHERE inventory_id = backup.inventory_id;
      INSERT INTO scraping_inventory_vehicle_brands(inventory_id,brand_id,confidence,evidence)
      SELECT r.inventory_id,r.brand_id,r.confidence,r.evidence
      FROM jsonb_populate_recordset(NULL::scraping_inventory_vehicle_brands,backup.before_brand_relations) r;
      restored := restored + 1;
    END LOOP;
    RETURN restored;
  END $$;
`);

exports.down = (pgm) => pgm.sql(`
  -- Recovery archives are deliberately retained; schema rollback never destroys backups.
  DROP FUNCTION IF EXISTS feyvi_restore_run(TEXT);
  DROP FUNCTION IF EXISTS feyvi_apply_patch(TEXT,JSONB,JSONB,TEXT);
  DROP FUNCTION IF EXISTS feyvi_search_text(JSONB);
  DROP FUNCTION IF EXISTS feyvi_merge_product(JSONB,JSONB);
`);
