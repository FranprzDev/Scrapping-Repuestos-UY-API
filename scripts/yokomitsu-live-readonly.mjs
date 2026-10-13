// Read-only snapshot of two public inventory records. Never changes data.
const base = "https://repuestoshopscrapping.up.railway.app/scraping/inventory";
for (const sku of ["7183011201", "7174571313"]) {
  const url = new URL(base);
  url.searchParams.set("search", sku);
  url.searchParams.set("limit", "50");
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("Inventory GET failed: " + response.status);
  const json = await response.json();
  const rows = (json.products ?? []).filter(p => p.sku === sku);
  console.log(JSON.stringify({
    checked: sku, total: json.total, matches: rows.map(p => ({
      sku: p.sku, price: p.price, sourceUrl: p.sourceUrl,
      extractedAt: p.extractedAt, updatedAt: p.updatedAt,
      lastSeenAt: p.lastSeenAt, site: p.site,
    })),
  }));
}
