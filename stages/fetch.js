// Stage 1: pull raw listings for one brand from its source.
// Shopify: the public /products.json, paginated (from legacy fetch_shopify.js).
// Amazon:  Apify junglee/amazon-crawler over a brand-facet search, detached + polled
//          (from legacy amazon_brand.js).
// Out: data/raw/<source>/<brand>.json, .manifest.json, and .diff.json against the previous pull.
import path from "node:path";
import fs from "node:fs";
import { brandBySlug, slugify } from "../lib/brands.js";
import { dir, readJson, writeJson } from "../lib/store.js";
import { THRESHOLDS } from "../config/rules.js";
import * as apify from "../lib/apify.js";

const UA = "Mozilla/5.0 (compatible; VantaOS catalog fetch)";

// ---------- Shopify ----------
export async function fetchShopify(store, { fetchImpl = fetch } = {}) {
  const products = [];
  for (let page = 1; page <= 40; page++) {
    const url = `https://${store}/products.json?limit=250&page=${page}`;
    const res = await fetchImpl(url, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`${store} page ${page}: HTTP ${res.status}`);
    const { products: batch } = await res.json();
    if (!batch?.length) break;
    products.push(...batch);
    if (batch.length < 250) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return products.map((p) => ({
    source: "shopify",
    store,
    id: p.id,
    handle: p.handle,
    url: `https://${store}/products/${p.handle}`,
    title: p.title,
    vendor: p.vendor,
    productType: p.product_type,
    tags: p.tags,
    bodyHtml: p.body_html,
    publishedAt: p.published_at,
    updatedAt: p.updated_at,
    options: p.options?.map((o) => o.name),
    variants: (p.variants || []).map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      price: v.price,
      compareAtPrice: v.compare_at_price,
      available: v.available,
      grams: v.grams,
      url: `https://${store}/products/${p.handle}?variant=${v.id}`,
    })),
    images: (p.images || []).map((i) => ({ src: i.src, alt: i.alt, w: i.width, h: i.height })),
  }));
}

// ---------- Amazon ----------
const num = (v) => (typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) || null : null);
const infoItem = (it, want) => {
  for (const x of it.importantInformation?.items || []) if ((x.title || "").toLowerCase().includes(want)) return x.text || null;
  return null;
};

// The crawler's field names have moved around between versions; read defensively.
export function normAmazon(it) {
  const price = it.price?.value ?? it.price?.amount ?? num(it.price) ?? num(it.priceText);
  const listPrice = it.listPrice?.value ?? num(it.listPrice);
  // highResolutionImages are the _SL1500_ originals; galleryThumbnails are ~40px and useless
  // for reading a label.
  const imgs = (it.highResolutionImages || []).length
    ? it.highResolutionImages
    : (it.images || it.galleryThumbnails || []).map((x) => (typeof x === "string" ? x : x.url || x.large || x.src)).filter(Boolean);
  const attrs = [...(it.attributes || []), ...(it.productOverview || [])];
  const flat = Object.fromEntries(attrs.map((a) => [String(a.key || a.name || "").toLowerCase(), a.value]));
  return {
    source: "amazon",
    store: "amazon.in",
    asin: it.asin || it.originalAsin || null,
    url: it.url || (it.asin ? `https://www.amazon.in/dp/${it.asin}` : null),
    title: it.title || null,
    brand: it.brand || flat.brand || flat.manufacturer || null,
    seller: it.seller?.name || null,
    price,
    listPrice,
    currency: "INR",
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
    // The ingredients text is the legal declaration: it names ingredients but carries NO
    // per-serving amounts, so the label photo is still needed for doses.
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
  };
}

export async function fetchAmazon(brandEntry, { max = THRESHOLDS.amazonMaxItems, pageSize = THRESHOLDS.amazonPageSize, keyword = false, runId, budget, log = console.log } = {}) {
  const rows = [];
  const seen = new Set();
  let usd = 0;
  let page = 0;
  for (let depth = 0; depth < max; depth += pageSize) {
    page++;
    // A brand facet surfaces a brand's most popular rows, which for a gear-heavy brand buries
    // the supplements. --keyword searches the phrase instead, with no brand filter.
    const url = apify.searchUrl(brandEntry.amazonBrand, { brandFacet: keyword ? null : brandEntry.amazonBrand, page });
    const r = await apify.runPage({ url, maxItems: pageSize, runId, stage: "fetch", budget });
    usd += r.usd;
    if (r.status !== "SUCCEEDED") {
      log(`  apify run ${r.status}, stopping`);
      break;
    }
    const fresh = r.rows.map(normAmazon).filter((x) => x.asin && !seen.has(x.asin));
    fresh.forEach((x) => seen.add(x.asin));
    rows.push(...fresh);
    const oos = fresh.filter((x) => x.inStock === false).length;
    const ratio = fresh.length ? oos / fresh.length : 1;
    log(`  page ${page}: ${fresh.length} new, ${oos} sold out (${(ratio * 100).toFixed(0)}%), $${usd.toFixed(2)} so far`);
    if (!fresh.length) {
      log("  no new products, stopping");
      break;
    }
    // Amazon's search runs out around 300 results and a brand's live catalogue usually ends
    // sooner; a mostly-sold-out page is where the listing turns into discontinued stock.
    if (ratio > THRESHOLDS.stopOutOfStockRatio) {
      log(`  over ${THRESHOLDS.stopOutOfStockRatio * 100}% sold out, stopping`);
      break;
    }
  }
  return { rows, usd };
}

// ---------- diff ----------
const idOf = (r) => (r.source === "amazon" ? r.asin : String(r.id));
const priceOf = (r) => (r.source === "amazon" ? r.price : Math.min(...(r.variants || []).map((v) => Number(v.price)).filter((n) => n > 0), Infinity));
const stockOf = (r) => (r.source === "amazon" ? r.inStock : (r.variants || []).some((v) => v.available !== false));

/** What changed since the previous pull: new listings, delisted ones, price and stock moves. */
export function diffPulls(previous, next) {
  const before = new Map((previous || []).map((r) => [idOf(r), r]));
  const after = new Map((next || []).map((r) => [idOf(r), r]));
  const out = { new: [], delisted: [], priceChanged: [], stockChanged: [] };
  for (const [id, r] of after) {
    const p = before.get(id);
    if (!p) {
      out.new.push({ id, title: r.title });
      continue;
    }
    const a = priceOf(p);
    const b = priceOf(r);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) out.priceChanged.push({ id, title: r.title, from: a, to: b });
    if (stockOf(p) !== stockOf(r)) out.stockChanged.push({ id, title: r.title, from: stockOf(p), to: stockOf(r) });
  }
  for (const [id, r] of before) if (!after.has(id)) out.delisted.push({ id, title: r.title });
  return out;
}

// ---------- stage entry ----------
export async function run({ brand, source, keyword = false, max, runId, budget, log = console.log }) {
  const entry = brandBySlug(slugify(brand)) || null;
  if (!entry) throw new Error(`unknown brand "${brand}" — add it to config/brands.json`);
  const src = source || (entry.shopify ? "shopify" : "amazon");
  const slug = slugify(entry.brand);
  const outDir = dir("raw", src);
  const file = path.join(outDir, `${slug}.json`);
  const previous = fs.existsSync(file) ? readJson(file, []) : null;

  let rows;
  let usd = 0;
  if (src === "shopify") {
    if (!entry.shopify) throw new Error(`${entry.brand} has no Shopify store; use --source amazon`);
    rows = await fetchShopify(entry.shopify);
  } else {
    if (!entry.amazonBrand) throw new Error(`${entry.brand} has no amazonBrand in config/brands.json`);
    const r = await fetchAmazon(entry, { max, keyword, runId, budget, log });
    rows = r.rows;
    usd = r.usd;
  }

  writeJson(file, rows);
  const diff = diffPulls(previous, rows);
  writeJson(path.join(outDir, `${slug}.diff.json`), { at: new Date().toISOString(), previous: previous ? previous.length : null, current: rows.length, ...diff });
  writeJson(path.join(outDir, `${slug}.manifest.json`), {
    brand: entry.brand,
    source: src,
    store: src === "shopify" ? entry.shopify : "amazon.in",
    products: rows.length,
    fetchedAt: new Date().toISOString(),
    usd,
  });
  log(
    `${entry.brand}: ${rows.length} raw listings` +
      (previous ? ` | +${diff.new.length} new, -${diff.delisted.length} delisted, ${diff.priceChanged.length} price, ${diff.stockChanged.length} stock` : " (first pull)") +
      (usd ? ` | apify $${usd.toFixed(2)}` : ""),
  );
  return { rows, diff, usd, file };
}
