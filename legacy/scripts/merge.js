#!/usr/bin/env node
// Merge the Shopify and Amazon catalogues into one product list.
// The same product often exists in both: the brand's own store gives the better label photos
// and every flavour/size variant, Amazon gives ratings, reviews and a live price. So we keep
// ONE record per product, preferring the better-verified side, and attach the other as a
// second offer rather than discarding it.
// Out: scripts/e2e/out/products/catalog.json (+ merge_report.json)
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "../../e2e/out/products");
const shop = JSON.parse(fs.readFileSync(path.join(OUT, "bulk/clean.json")));
const amz = fs.existsSync(path.join(OUT, "amazon/clean.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "amazon/clean.json"))) : [];

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(("the a an and for with of in on to by pack packs bottle bottles jar box capsules capsule tablets tablet " +
  "powder softgels softgel gummies gummy sachets sachet veg vegetarian vegan premium pure natural advanced pro plus " +
  "supplement supplements nutrition men women unisex adults india indian free sugar flavour flavor flavoured g gm kg mg ml l n nos count").split(" "));
const tokens = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));
const jaccard = (a, b) => { let i = 0; for (const w of a) if (b.has(w)) i++; return i / Math.max(1, Math.min(a.size, b.size)); };

// Amounts give a much stronger signal than words: two records for the same product agree on
// their actives. Compare normalised mg values of the top actives.
const F = { g: 1000, gm: 1000, mg: 1, mcg: 0.001, "µg": 0.001, ug: 0.001 };
const doseKey = (p) => {
  const a = p.ingredients.filter((r) => r.role === "active" && r.amount != null && F[String(r.unit).toLowerCase()])
    .map((r) => Math.round(r.amount * F[String(r.unit).toLowerCase()]))
    .sort((x, y) => y - x).slice(0, 4);
  return a.length >= 2 ? a.join("-") : null;
};

const brandIndex = new Map();
for (const p of amz) {
  const b = norm(p.brand);
  if (!brandIndex.has(b)) brandIndex.set(b, []);
  brandIndex.get(b).push({ p, tok: tokens(`${p.productName} ${p.title}`), dose: doseKey(p) });
}

const rank = { label_read: 3, unverified_low_res: 2, unverified_low_confidence: 2, unverified_no_label: 1, unverified_title_only: 0 };
const offerOf = (p) => ({
  source: p.source || "shopify", store: p.store, url: p.url,
  price: p.priceMin ?? null, priceMax: p.priceMax ?? null, listPrice: p.listPrice ?? null,
  inStock: p.inStock ?? (p.priceMin != null ? true : null), variants: p.variants || [],
});

const catalog = [], report = { matched: 0, shopifyOnly: 0, amazonOnly: 0, pairs: [] };
const usedAmz = new Set();

for (const s of shop) {
  const cands = brandIndex.get(norm(s.brand)) || [];
  const st = tokens(`${s.productName} ${s.title}`), sd = doseKey(s);
  let best = null, bestScore = 0;
  for (const c of cands) {
    if (usedAmz.has(c.p.key)) continue;
    const words = jaccard(st, c.tok);
    const doseHit = sd && c.dose && sd === c.dose;
    // Dose agreement carries a match that words alone would not; words alone need to be strong.
    const score = doseHit ? Math.max(0.8, words) : words;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  const m = best && bestScore >= 0.62 ? best.p : null;
  if (m) {
    usedAmz.add(m.key);
    report.matched++;
    if (report.pairs.length < 40) report.pairs.push({ score: +bestScore.toFixed(2), shopify: s.title.slice(0, 55), amazon: m.title.slice(0, 55) });
    // Keep whichever side read the label better; carry the other as a second offer.
    const primary = (rank[m.verification] ?? 0) > (rank[s.verification] ?? 0) ? m : s;
    const other = primary === m ? s : m;
    catalog.push({
      ...primary,
      key: s.key,
      sources: ["shopify", "amazon"],
      offers: [offerOf(s), offerOf(m)],
      priceMin: Math.min(...[s.priceMin, m.priceMin].filter((n) => n != null)) || null,
      priceMax: Math.max(...[s.priceMax, m.priceMax].filter((n) => n != null)) || null,
      rating: m.rating, reviewCount: m.reviewCount, reviewsSummary: m.reviewsSummary,
      reviewKeywords: m.reviewKeywords, starsBreakdown: m.starsBreakdown, reviewsLink: m.reviewsLink,
      bestsellerRank: m.bestsellerRank, monthlyPurchaseVolume: m.monthlyPurchaseVolume,
      ingredientsDeclared: m.ingredientsDeclared,
      asin: m.asin,
      labelImages: (primary.labelImages || []).length ? primary.labelImages : other.labelImages,
      secondaryVerification: other.verification,
    });
  } else {
    report.shopifyOnly++;
    catalog.push({ ...s, sources: ["shopify"], offers: [offerOf(s)] });
  }
}
for (const a of amz) {
  if (usedAmz.has(a.key)) continue;
  report.amazonOnly++;
  catalog.push({ ...a, sources: ["amazon"], offers: [offerOf(a)] });
}

fs.writeFileSync(path.join(OUT, "catalog.json"), JSON.stringify(catalog, null, 1));
fs.writeFileSync(path.join(OUT, "merge_report.json"), JSON.stringify(report, null, 2));
const v = {}, byBrand = {};
for (const p of catalog) { v[p.verification] = (v[p.verification] || 0) + 1; byBrand[p.brand] = (byBrand[p.brand] || 0) + 1; }
console.log(`catalog ${catalog.length} products`);
console.log(`  both sources ${report.matched} | shopify only ${report.shopifyOnly} | amazon only ${report.amazonOnly}`);
console.log(`  with rating ${catalog.filter((p) => p.rating).length} | with review summary ${catalog.filter((p) => p.reviewsSummary).length}`);
console.log("verification", v);
console.log("brands", Object.keys(byBrand).length);
