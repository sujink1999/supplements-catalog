#!/usr/bin/env node
// Find a live Amazon price for products whose own store shows every variant sold out.
// Facts are untouched: this only adds an offer, a rating and stock.
// Usage: APIFY_TOKEN=... node amazon_price.js [--limit N] [--per 3] [--conc 8]
// Out: scripts/e2e/out/products/bulk/price_patch.json
const fs = require("fs"), path = require("path");
{ const fs0 = require("fs");
  for (const root of [path.join(__dirname, "../../.."), path.join(__dirname, "../../../../../..")]) {
    if (fs0.existsSync(path.join(root, ".env"))) { require("dotenv").config({ path: path.join(root, ".env"), quiet: true }); require("dotenv").config({ path: path.join(root, ".env.local"), override: true, quiet: true }); break; } } }
const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const LIMIT = Number(flag("--limit", 0)), PER = Number(flag("--per", 3)), CONC = Number(flag("--conc", 8));
const OUT = path.join(__dirname, "../../e2e/out/products");
const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) { console.error("APIFY_TOKEN missing"); process.exit(1); }

const STOP = new Set("the a an and for with of in on to by pack bottle jar box capsules capsule tablets tablet powder softgels gummies sachets sachet veg vegan premium pure natural advanced pro plus supplement supplements nutrition men women india indian free sugar flavour flavor herbal ayurvedic nano gold trial starter".split(" "));
const stem = (w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);
const toks = (s) => new Set(String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").toLowerCase()
  .split(" ").filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem));

(async () => {
  const all = JSON.parse(fs.readFileSync(path.join(OUT, "bulk/clean.json")));
  let todo = all.filter((p) => p.priceMin == null);
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log(`${todo.length} products with no live price`);
  const patch = {};
  let usd = 0, n = 0, hit = 0;
  const queue = [...todo];
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const p = queue.shift();
      const q = `${p.brand} ${p.productName || p.title}`.replace(/\s+/g, " ").slice(0, 90);
      try {
        const body = { categoryOrProductUrls: [{ url: `https://www.amazon.in/s?k=${encodeURIComponent(q)}` }],
          maxItemsPerStartUrl: PER, scrapeProductDetails: true, proxyCountry: "IN", useCaptchaSolver: false };
        const s = await fetch(`https://api.apify.com/v2/acts/junglee~amazon-crawler/runs?token=${TOKEN}&memory=1024`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!s.ok) { n++; continue; }
        const id = (await s.json()).data.id;
        let d;
        for (;;) { await new Promise((r) => setTimeout(r, 12000));
          d = (await (await fetch(`https://api.apify.com/v2/actor-runs/${id}?token=${TOKEN}`)).json()).data;
          if (d.status !== "RUNNING" && d.status !== "READY") break; }
        usd += d.usageTotalUsd || 0;
        if (d.status !== "SUCCEEDED") { n++; continue; }
        const items = await (await fetch(`https://api.apify.com/v2/datasets/${d.defaultDatasetId}/items?token=${TOKEN}&limit=20`)).json();
        const pt = toks(`${p.productName} ${p.title}`), bt = toks(p.brand);
        const best = items.map((it) => {
          const t = toks(it.title); const shared = [...pt].filter((w) => t.has(w));
          const brandOk = [...bt].some((w) => t.has(w)) || toks(it.brand).size && [...bt].some((w) => toks(it.brand).has(w));
          return { it, shared: shared.length, brandOk, price: (it.price || {}).value };
        }).filter((c) => c.brandOk && c.shared >= 2 && c.price > 0)
          .sort((a, b) => b.shared - a.shared)[0];
        if (best) {
          hit++;
          patch[p.key] = { price: best.price, listPrice: (best.it.listPrice || {}).value ?? null,
            url: best.it.url, asin: best.it.asin, inStock: best.it.inStock ?? null,
            rating: best.it.stars ?? null, reviewCount: best.it.reviewsCount ?? null,
            reviewsSummary: (best.it.aiReviewsSummary || {}).text || null, matchShared: best.shared };
        }
      } catch (e) { /* one failed lookup must not stop the sweep */ }
      if (++n % 25 === 0) console.log(`  ${n}/${todo.length} looked up, ${hit} priced, $${usd.toFixed(2)}`);
    }
  }));
  fs.writeFileSync(path.join(OUT, "bulk/price_patch.json"), JSON.stringify(patch, null, 1));
  console.log(`\n${hit} of ${todo.length} got a live Amazon price | $${usd.toFixed(2)}`);
})();
