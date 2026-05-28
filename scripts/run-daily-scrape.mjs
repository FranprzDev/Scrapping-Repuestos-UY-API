#!/usr/bin/env node

const apiBaseUrl = process.env.SCRAPER_API_BASE_URL ?? 'http://localhost:3001';
const endpoint = `${apiBaseUrl.replace(/\/+$/, '')}/scraping/catalog/run`;

const payload = {
  maxPagesPerSite: toNumber(process.env.SCRAPE_MAX_PAGES_PER_SITE, 30),
  maxProductsPerSite: toNumber(process.env.SCRAPE_MAX_PRODUCTS_PER_SITE, 150),
  siteConcurrency: toNumber(process.env.SCRAPE_SITE_CONCURRENCY, 2),
};

if (process.env.SCRAPE_URLS) {
  payload.urls = process.env.SCRAPE_URLS.split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

const startedAt = Date.now();

try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  if (!response.ok) {
    console.error(`[scrape:daily] HTTP ${response.status} body=${responseText}`);
    process.exit(1);
  }

  console.log(`[scrape:daily] completed in ${Date.now() - startedAt}ms`);
  console.log(responseText);
} catch (error) {
  console.error(`[scrape:daily] failed: ${formatError(error)}`);
  process.exit(1);
}

function toNumber(input, fallback) {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
