#!/usr/bin/env node
// ONE amazon.in search through Apify junglee/amazon-crawler to confirm: INR prices, ingredients box, rating + review count fields.
// Cost: ~20 results ≈ $0.10. Output: scripts/e2e/out/products/verify/apify-probe.json
// Usage: APIFY_TOKEN=... node apify_probe.js ["ashwagandha"]
const fs = require("fs");
const path = require("path");
const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) { console.error("APIFY_TOKEN missing"); process.exit(1); }
const q = process.argv[2] || "ashwagandha";
const OUT = path.join(__dirname, "../../../e2e/out/products/verify/apify-probe.json");

(async () => {
  const input = { categoryOrProductUrls: [{ url: `https://www.amazon.in/s?k=${encodeURIComponent(q)}` }], maxItemsPerStartUrl: 20, scrapeProductDetails: true, scrapeProductVariantPrices: false, proxyCountry: "IN", useCaptchaSolver: false };
  const run = await fetch(`https://api.apify.com/v2/acts/junglee~amazon-crawler/run-sync-get-dataset-items?token=${TOKEN}&timeout=300&memory=1024`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  if (!run.ok) { console.error("HTTP", run.status, await run.text()); process.exit(1); }
  const items = await run.json();
  fs.writeFileSync(OUT, JSON.stringify(items, null, 1));
  console.log(items.length, "items →", OUT);
  if (!items.length) return;
  console.log("fields:", Object.keys(items[0]).join(", "));
  for (const it of items.slice(0, 20)) {
    const text = JSON.stringify(it);
    console.log(`${(it.asin || "").padEnd(12)} ${String(it.price?.value ?? it.price ?? "").padStart(8)} ${it.price?.currency || ""} ★${it.stars ?? it.rating ?? "?"} (${it.reviewsCount ?? it.ratingsCount ?? "?"}) ing:${/ingredient/i.test(text)} ${String(it.title || "").slice(0, 60)}`);
  }
})();
