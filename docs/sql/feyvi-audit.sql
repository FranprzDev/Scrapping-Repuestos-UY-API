-- SELECT only. Audit every Feyvi row, including legacy/malformed detail URLs.
WITH feyvi AS (
  SELECT id, source_url, product, updated_at,
    regexp_replace(btrim(coalesce(product->>'price','')), '(UYU|\$U|\$|\s)', '', 'gi') AS raw_price,
    lower(regexp_replace(regexp_replace(split_part(source_url,'#',1),'^(https?://)www\.', '\1','i'), '/+$', '')) AS canonical_url
  FROM scraping_inventory
  WHERE source_url ~* '^https?://(www\.)?feyvi\.com\.uy/'
), normalized AS (
  SELECT *, CASE
    WHEN raw_price ~ '^[+-]?[0-9]+([.,][0-9]+)*$' THEN
      CASE
        WHEN raw_price ~ '\.[0-9]{1,2}$' AND raw_price LIKE '%,%' THEN replace(raw_price,',','')
        WHEN raw_price ~ ',[0-9]{1,2}$' THEN replace(replace(raw_price,'.',''),',','.')
        WHEN raw_price ~ '\.[0-9]{1,2}$' THEN regexp_replace(raw_price, '\.(?=.*\.)', '', 'g')
        ELSE replace(replace(raw_price,',',''),'.','')
      END::numeric
    ELSE NULL END AS price_amount
  FROM feyvi
)
SELECT count(*) AS total_feyvi,
  count(*) FILTER (WHERE nullif(btrim(product->>'price'),'') IS NULL) AS missing_price,
  count(*) FILTER (WHERE price_amount IS NULL) AS missing_or_unparseable_price,
  count(*) FILTER (WHERE price_amount = 0) AS zero_price,
  count(*) FILTER (WHERE price_amount < 0) AS negative_price,
  count(*) FILTER (WHERE price_amount > 0 AND price_amount < 20) AS suspicious_under_20,
  count(*) FILTER (WHERE nullif(btrim(product->>'sku'),'') IS NULL) AS missing_sku,
  count(*) FILTER (WHERE nullif(btrim(product->>'brand'),'') IS NULL) AS missing_manufacturer,
  count(*) FILTER (WHERE coalesce(product->'compatibleModels','null'::jsonb) IN ('null'::jsonb,'[]'::jsonb)
    AND coalesce(product->'compatibleVehicles','null'::jsonb) IN ('null'::jsonb,'[]'::jsonb)) AS missing_compatibility,
  count(*) FILTER (WHERE nullif(product->>'imageUrl','') IS NULL
    OR product->>'imageUrl' ~* '(logo|placeholder|sin-imagen|no-image|banner)') AS suspicious_or_missing_image,
  (SELECT count(*) FROM (SELECT canonical_url FROM normalized GROUP BY canonical_url HAVING count(*) > 1) d) AS duplicate_url_groups,
  (SELECT count(*) FROM (SELECT product->>'sku' FROM normalized WHERE nullif(btrim(product->>'sku'),'') IS NOT NULL
    GROUP BY product->>'sku' HAVING count(*) > 1) d) AS duplicate_sku_groups
FROM normalized;

-- Records for follow-up; do not delete duplicates automatically.
SELECT id,source_url,product->>'sku' AS sku,product->>'price' AS price,
  product->>'currency' AS currency,product->>'imageUrl' AS image_url,updated_at
FROM scraping_inventory WHERE source_url ~* '^https?://(www\.)?feyvi\.com\.uy/'
ORDER BY id;
