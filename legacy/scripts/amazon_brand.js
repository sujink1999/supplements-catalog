#!/usr/bin/env node
// Pull one brand's supplement listings from amazon.in via Apify junglee/amazon-crawler.
// Used for brands with no public Shopify feed (HealthKart, MuscleBlaze, Kapiva, ...) and
// to fill in label data for Shopify products whose photos had no readable facts panel.
//
// Usage: APIFY_TOKEN=... node amazon_brand.js "MuscleBlaze" [--max 40] [--out <dir>]
// Out:   scripts/e2e/out/products/amazon/<brand>.json
const fs = require("fs"), path = require("path");
{ const fs0 = require("fs");
  for (const root of [path.join(__dirname, "../../.."), path.join(__dirname, "../../../../../..")]) {
    if (fs0.existsSync(path.join(root, ".env"))) { require("dotenv").config({ path: path.join(root, ".env"), quiet: true }); require("dotenv").config({ path: path.join(root, ".env.local"), override: true, quiet: true }); break; } } }

const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const BRAND = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--max" && args[args.indexOf(a) - 1] !== "--out")[0];
const MAX = Number(flag("--max", 40));
const OUT = path.resolve(flag("--out", path.join(__dirname, "../../e2e/out/products/amazon")));
const TOKEN = process.env.APIFY_TOKEN;
if (!BRAND) { console.error('usage: node amazon_brand.js "MuscleBlaze" [--max 40]'); process.exit(1); }
if (!TOKEN) { console.error("APIFY_TOKEN missing (put it in .env.local)"); process.exit(1); }

// Keep the query tight: the brand plus the category, so we get supplements and not merch.


const num = (v) => (typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) || null : null);

// The crawler's field names have moved around between versions; read defensively.
const infoItem = (it, want) => {
  for (const x of it.importantInformation?.items || []) if ((x.title || "").toLowerCase().includes(want)) return x.text || null;
  return null;
};

// The crawler's field names have moved around between versions; read defensively.
const norm = (it) => {
  const price = it.price?.value ?? it.price?.amount ?? num(it.price) ?? num(it.priceText);
  const listPrice = it.listPrice?.value ?? num(it.listPrice);
  // highResolutionImages are the _SL1500_ originals; galleryThumbnails are ~40px and useless for label reading.
  const imgs = (it.highResolutionImages || []).length
    ? it.highResolutionImages
    : (it.images || it.galleryThumbnails || []).map((x) => (typeof x === "string" ? x : x.url || x.large || x.src)).filter(Boolean);
  const attrs = [...(it.attributes || []), ...(it.productOverview || [])];
  const flat = Object.fromEntries(attrs.map((a) => [String(a.key || a.name || "").toLowerCase(), a.value]));
  return {
    asin: it.asin || it.originalAsin || null,
    url: it.url || (it.asin ? `https://www.amazon.in/dp/${it.asin}` : null),
    title: it.title || null,
    brand: it.brand || flat.brand || flat.manufacturer || null,
    seller: it.seller?.name || null,
    price, listPrice, currency: "INR",
    inStock: it.inStock ?? null,
    rating: it.stars ?? null,
    reviewCount: it.reviewsCount ?? null,
    starsBreakdown: it.starsBreakdown || null,
    reviewsSummary: it.aiReviewsSummary?.text || null,
    reviewKeywords: (it.aiReviewsSummary?.keywords || []).map((k) => ({ name: k.name, sentiment: k.sentiment })),
    reviewsLink: it.reviewsLink || null,
    monthlyPurchaseVolume: it.monthlyPurchaseVolume || null,
    bestsellerRank: (it.bestsellerRanks || [])[0] || null,
    breadCrumbs: it.breadCrumbs || null,
    images: imgs,
    // Amazon's own structured bits. The ingredients text is the legal declaration:
    // it names ingredients but carries NO per-serving amounts, so the label photo is still needed for doses.
    ingredientsText: infoItem(it, "ingredient"),
    doseDirections: infoItem(it, "direction") || infoItem(it, "usage"),
    safetyInfo: infoItem(it, "safety"),
    itemForm: flat["item form"] || flat["dosage form"] || null,
    unitCount: flat["unit count"] || flat["item weight"] || flat["net quantity"] || null,
    dietType: flat["diet type"] || null,
    supplementType: flat["primary supplement type"] || null,
    countryOfOrigin: flat["country of origin"] || null,
    manufacturer: flat.manufacturer || null,
    description: it.aPlusContent?.rawText || it.description || null,
    features: it.features || null,
    raw: it,
  };
};

// Amazon's own search runs out around 300 results, and a brand's live catalogue usually
// ends sooner. Crawl in pages; stop early once a page comes back mostly sold out, since
// that is where the listing turns into discontinued stock.
const PAGE = Number(flag("--page", 30));
const STOP_OOS = 0.34;
const KEYWORD = args.includes("--keyword");

const startRun = async (url, max) => {
  const body = { categoryOrProductUrls: [{ url }], maxItemsPerStartUrl: max, scrapeProductDetails: true,
    scrapeProductVariantPrices: false, proxyCountry: "IN", useCaptchaSolver: false };
  const r = await fetch(`https://api.apify.com/v2/acts/junglee~amazon-crawler/runs?token=${TOKEN}&memory=1024`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`start HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data;
};
// Runs routinely exceed the 300s synchronous API limit, so start detached and poll.
const waitRun = async (id) => {
  for (;;) {
    await new Promise((s) => setTimeout(s, 15000));
    const r = await fetch(`https://api.apify.com/v2/actor-runs/${id}?token=${TOKEN}`);
    const d = (await r.json()).data;
    if (d.status !== "RUNNING" && d.status !== "READY") return d;
  }
};
const items = async (dsId) => {
  const r = await fetch(`https://api.apify.com/v2/datasets/${dsId}/items?token=${TOKEN}&limit=1000`);
  return r.ok ? r.json() : [];
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const seen = new Set();
  const rows = [];
  let usd = 0, page = 0;
  for (let depth = 0; depth < MAX; depth += PAGE) {
    page++;
    // A brand filter surfaces a brand's most popular rows, which for a gear-heavy brand
    // buries the supplements. --keyword searches the phrase instead, with no brand filter.
    const base = KEYWORD
      ? `https://www.amazon.in/s?k=${encodeURIComponent(BRAND)}`
      : `https://www.amazon.in/s?k=${encodeURIComponent(BRAND)}&rh=p_89%3A${encodeURIComponent(BRAND)}`;
    const url = base + (page > 1 ? `&page=${page}` : "");
    process.stdout.write(`page ${page} (depth ${depth + 1}-${Math.min(MAX, depth + PAGE)}) ... `);
    let run;
    try { run = await startRun(url, PAGE); } catch (e) { console.log("start failed:", e.message); break; }
    const done = await waitRun(run.id);
    usd += done.usageTotalUsd || 0;
    if (done.status !== "SUCCEEDED") { console.log(`run ${done.status}`); break; }
    const raw = await items(done.defaultDatasetId);
    const fresh = raw.map(norm).filter((r) => r.asin && !seen.has(r.asin));
    fresh.forEach((r) => seen.add(r.asin));
    const oos = fresh.filter((r) => r.inStock === false).length;
    const ratio = fresh.length ? oos / fresh.length : 1;
    rows.push(...fresh);
    console.log(`${fresh.length} new, ${oos} sold out (${(ratio * 100).toFixed(0)}%), $${usd.toFixed(2)} so far`);
    if (!fresh.length) { console.log("  no new products, stopping"); break; }
    if (ratio > STOP_OOS) { console.log(`  over ${STOP_OOS * 100}% sold out, stopping`); break; }
  }

  const file = path.join(OUT, `${BRAND.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 1));
  const has = (k) => rows.filter((r) => r[k]).length;
  const onBrand = rows.filter((r) => (r.brand || r.title || "").toLowerCase().includes(BRAND.toLowerCase()));
  console.log(`\n${rows.length} products -> ${file}   apify $${usd.toFixed(2)}`);
  console.log(`on-brand ${onBrand.length} | in stock ${rows.filter((r) => r.inStock !== false).length} | price ${has("price")} | rating ${has("rating")} | reviewSummary ${has("reviewsSummary")} | ingredients ${has("ingredientsText")} | directions ${has("doseDirections")} | images ${rows.filter((r) => r.images.length).length}`);
})();
