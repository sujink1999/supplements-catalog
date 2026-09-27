#!/usr/bin/env node
// For products whose Shopify photos had no readable facts panel (or a low-confidence read),
// find the same product on amazon.in and re-read the label off Amazon's 1500px images.
// Writes one candidate file per product; extraction is a separate step (extract2.js).
//
// Usage: APIFY_TOKEN=... node amazon_fill.js [--limit 5] [--per 4] [--verification unverified_no_label,unverified_low_res]
// Out:   scripts/e2e/out/products/amazon/fill/<key>.json  and  fill_input.json (extractor input)
const fs = require("fs"), path = require("path");
{ const fs0 = require("fs");
  for (const root of [path.join(__dirname, "../../.."), path.join(__dirname, "../../../../../..")]) {
    if (fs0.existsSync(path.join(root, ".env"))) { require("dotenv").config({ path: path.join(root, ".env"), quiet: true }); require("dotenv").config({ path: path.join(root, ".env.local"), override: true, quiet: true }); break; } } }

const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const LIMIT = Number(flag("--limit", 5));
const PER = Number(flag("--per", 4));
const CLASSES = (flag("--verification", "unverified_no_label,unverified_low_res,unverified_low_confidence,unverified_title_only")).split(",");
const CONC = Number(flag("--conc", 8));
const DIR = path.join(__dirname, "../../e2e/out/products");
const OUT = path.join(DIR, "amazon/fill");
const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) { console.error("APIFY_TOKEN missing"); process.exit(1); }

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
// Jaccard on title words, plus the brand must appear. Cheap, and a wrong product is worse than none.
const score = (a, b) => { const A = words(a), B = words(b); let i = 0; for (const w of A) if (B.has(w)) i++; return i / Math.max(1, Math.min(A.size, B.size)); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const clean = JSON.parse(fs.readFileSync(path.join(DIR, "bulk/clean.json")));
  const todo = clean.filter((p) => CLASSES.includes(p.verification)).slice(0, LIMIT);
  console.log(`${todo.length} products to look up on amazon.in (of ${clean.length} clean)`);
  const inputs = [];
  let spentItems = 0, usd = 0, n = 0;
  const queue = [...todo];
  const one = async (p) => {

    const q = `${p.brand || p.vendor || ""} ${p.productName || p.title}`.replace(/\s+/g, " ").trim().slice(0, 90);
    const body = { categoryOrProductUrls: [{ url: `https://www.amazon.in/s?k=${encodeURIComponent(q)}` }], maxItemsPerStartUrl: PER, scrapeProductDetails: true, scrapeProductVariantPrices: false, proxyCountry: "IN", useCaptchaSolver: false };
    const start = await fetch(`https://api.apify.com/v2/acts/junglee~amazon-crawler/runs?token=${TOKEN}&memory=1024`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!start.ok) { console.log(`ERR ${p.key} start HTTP ${start.status}`); return; }
    const runId = (await start.json()).data.id;
    let done;
    for (;;) {
      await new Promise((r) => setTimeout(r, 12000));
      done = (await (await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${TOKEN}`)).json()).data;
      if (done.status !== "RUNNING" && done.status !== "READY") break;
    }
    usd += done.usageTotalUsd || 0;
    if (done.status !== "SUCCEEDED") { console.log(`ERR ${p.key} run ${done.status}`); return; }
    const items = await (await fetch(`https://api.apify.com/v2/datasets/${done.defaultDatasetId}/items?token=${TOKEN}&limit=100`)).json();
    spentItems += items.length;
    const ranked = items.map((it) => ({ it, s: score(p.title, it.title || "") })).sort((a, b) => b.s - a.s);
    const best = ranked[0];
    const brandOk = best && norm(best.it.brand || best.it.title || "").includes(norm(p.brand || p.vendor || "").split(" ")[0] || "zzz");
    console.log(`  ${best ? best.s.toFixed(2) : "-"} ${brandOk ? "brand✓" : "brand✗"} ${items.length} hits | ${p.title.slice(0, 40)} -> ${(best?.it.title || "none").slice(0, 45)}`);
    if (!best || best.s < 0.5 || !brandOk) return;
    const it = best.it;
    fs.writeFileSync(path.join(OUT, `${p.key}.json`), JSON.stringify({ key: p.key, shopifyTitle: p.title, matchScore: best.s, amazon: it }, null, 1));
    const imgs = (it.highResolutionImages || []).slice(0, 12).map((u) => ({ src: u, w: 1500, h: 1500 }));
    if (imgs.length) inputs.push({ store: "amazon.in", id: `${p.key}__${it.asin}`, url: it.url, title: it.title, vendor: it.brand || p.brand || "", productType: "", tags: [], bodyHtml: [it.aPlusContent?.rawText, ...(it.features || [])].filter(Boolean).join(" "), variants: [{ title: "default", price: it.price?.value }], images: imgs, shopifyKey: p.key });
  };
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const p = queue.shift();
      try { await one(p); } catch (e) { console.log(`ERR ${p.key} ${e.message.slice(0, 80)}`); }
      if (++n % 25 === 0) console.log(`  -- ${n}/${todo.length} looked up, $${usd.toFixed(2)}`);
    }
  }));
  fs.writeFileSync(path.join(DIR, "amazon/fill_input.json"), JSON.stringify(inputs, null, 1));
  console.log(`\n${inputs.length} matched with images -> amazon/fill_input.json | ${spentItems} apify results, $${usd.toFixed(2)}`);
})();
