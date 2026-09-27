#!/usr/bin/env node
// Clean the Amazon extractions the same way as the Shopify ones, then carry across the
// fields only Amazon gives us: rating, review count and summary, the legal ingredients
// declaration, bestseller rank, live stock.
// Out: scripts/e2e/out/products/amazon/clean.json (+ rejects.json)
const fs = require("fs"), path = require("path");
const D = path.join(__dirname, "../../e2e/out/products/amazon");
const EX = path.join(D, "extracted");

const meta = new Map(JSON.parse(fs.readFileSync(path.join(D, "prepared.json"))).map((r) => [r.asin, r]));
const CERTS = fs.existsSync(path.join(D, "certs_patch.json")) ? JSON.parse(fs.readFileSync(path.join(D, "certs_patch.json"))) : {};
// Judged text claims and pack marks live alongside the Shopify ones, keyed the same way.
const B = path.join(__dirname, "../../e2e/out/products/bulk");
const readDir = (dir) => {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try { out[f.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(dir, f))); } catch {}
  }
  return out;
};
const JUDGED = readDir(path.join(B, "certs_judged"));
const MARKS = readDir(path.join(B, "marks"));
const TOPICAL = /\b(serum|cream|lotion|shampoo|conditioner|balm|face wash|body wash|scrub|hair oil|massage oil|roll-?on|toothpaste|mouthwash|soap|topical)\b/i;
const TOPICAL_FORM = /^(cream|serum|gel|lotion|topical|spray)$/i;

// Amazon brand strings are shouty and inconsistent ("PLIX - THE PLANT FIX"); settle on one.
const BRAND_NAME = {
  "plix-the-plant-fix": "Plix", "hk-vitals": "HK Vitals", "be-bodywise": "Be Bodywise",
  "bhumija-lifesciences": "Bhumija Lifesciences", "nature-s-velvet": "Nature's Velvet",
  "the-whole-truth": "The Whole Truth", "muscleblaze": "MuscleBlaze", "man-matters": "Man Matters",
  "truebasics": "TrueBasics", "boldfit": "Boldfit", "kapiva": "Kapiva", "nutrabay": "Nutrabay",
  "avvatar": "Avvatar", "swisse": "Swisse", "rasayanam": "Rasayanam", "healthkart": "HealthKart",
  "autoimmunity-care": "Autoimmunity Care",
  // "Be." is the brand string on Amazon; the packs read "Be Wellness".
  "be-": "Be Wellness", "be-supplement": "Be Wellness", "be-vitamin": "Be Wellness", "be-wellness-gummies": "Be Wellness",
};

const clean = [], rejects = [];
const why = {};
const rej = (key, reason, extra) => { why[reason] = (why[reason] || 0) + 1; rejects.push({ key, reason, ...extra }); };

for (const f of fs.readdirSync(EX).filter((f) => f.endsWith(".json"))) {
  const x = JSON.parse(fs.readFileSync(path.join(EX, f)));
  const key = f.replace(".json", "");
  const a = meta.get(String(x.id));
  const ck = `amazon.in__${x.id}`;
  const c = x.classify, fa = x.facts;
  if (c.listing !== "supplement") { rej(key, "not_supplement", { title: x.title }); continue; }
  if (c.pack === "bundle") { rej(key, "bundle", { title: x.title }); continue; }
  if (c.pack === "multipack") { rej(key, "multipack", { title: x.title }); continue; }
  if (!fa) { rej(key, "no_facts", { title: x.title }); continue; }
  if (TOPICAL.test(x.title) || TOPICAL_FORM.test(fa.formFactor || "")) { rej(key, "topical", { title: x.title }); continue; }

  const acts = fa.rows.filter((r) => r.role === "active");
  let titleOnly = false;
  if (!acts.length) {
    if (x.labelImages.length || /\b(pack|bundle|combo|kit|stack)\b/i.test(x.title)) { rej(key, "no_actives", { title: x.title }); continue; }
    titleOnly = true; why.kept_title_only = (why.kept_title_only || 0) + 1;
  }
  const verification = titleOnly ? "unverified_title_only"
    : !x.labelImages.length ? "unverified_no_label"
    : fa.lowResLabel ? "unverified_low_res"
    : fa.confidence < 0.7 ? "unverified_low_confidence" : "label_read";

  clean.push({
    key: ck, source: "amazon", store: "amazon.in", id: x.id, asin: x.id,
    url: x.url, title: x.title,
    brand: BRAND_NAME[a?.brandFile] || a?.brand || fa.brand, brandRaw: a?.brand || null,
    productName: fa.productName, productType: a?.supplementType || null, tags: [],
    pack: c.pack, formFactor: fa.formFactor || (a?.itemForm || "").toLowerCase() || null,
    servingSize: fa.servingSize, servingsPerContainer: fa.servingsPerContainer,
    netQuantity: fa.netQuantity, unitsInContainer: c.unitsInContainer,
    doseDirections: fa.doseDirections || a?.doseDirections || null,
    priceMin: a?.price ?? null, priceMax: a?.price ?? null, listPrice: a?.listPrice ?? null, currency: "INR",
    inStock: a?.inStock ?? null,
    variants: a?.price ? [{ id: x.id, title: a.unitCount || "default", price: a.price, url: x.url }] : [],
    imageUrl: x.tiles[c.frontTile ?? 0]?.src || x.tiles[0]?.src || null, labelImages: x.labelImages,
    ingredients: fa.rows,
    // Amazon-only signal. The declaration lists ingredients in order with no amounts,
    // so it supports matching and allergen questions, never a dose.
    ingredientsDeclared: a?.ingredientsText || null,
    rating: a?.rating ?? null, reviewCount: a?.reviewCount ?? null,
    starsBreakdown: a?.starsBreakdown || null, reviewsSummary: a?.reviewsSummary || null,
    reviewKeywords: a?.reviewKeywords || [], reviewsLink: a?.reviewsLink || null,
    bestsellerRank: a?.bestsellerRank || null, monthlyPurchaseVolume: a?.monthlyPurchaseVolume || null,
    seller: a?.seller || null, dietType: a?.dietType || null, countryOfOrigin: a?.countryOfOrigin || null,
    claimedTesting: (JUDGED[ck]?.productTesting || []).map((t) => ({ kind: t.kind, programme: t.programme, everyBatch: t.everyBatch, quote: t.quote })),
    claimedPurity: JUDGED[ck]?.purityClaims || [],
    claimedFacility: JUDGED[ck]?.facilityOrLicence || [],
    claimedDiet: JUDGED[ck]?.dietFlags || [],
    ingredientLevelCertifications: JUDGED[ck]?.ingredientLevel || [],
    packTestingMarks: (MARKS[ck]?.testingMarks || []).filter((m) => m.legible).map((m) => ({ mark: m.mark, kind: m.kind })),
    packCertificationMarks: (MARKS[ck]?.certificationMarks || []).filter((m) => m.legible).map((m) => m.mark),
    packDietMarks: MARKS[ck]?.dietMarks || [],
    allergens: MARKS[ck]?.allergens || null,
    fssaiLicences: MARKS[ck]?.fssaiLicences || [],
    illegibleBadges: MARKS[ck]?.illegibleBadgeCount ?? null,
    certificationsRead: { text: Boolean(JUDGED[ck]), pack: Boolean(MARKS[ck]) },
    keywordClaims: (CERTS[x.id] || {}).claims || [],
    // A bar is dosed like a supplement but eaten like food: flagged so a recommender can
    // keep it out of an answer about capsules without having to parse the form string.
    isFoodForm: fa.formFactor === "bar",
    confidence: fa.confidence, verification, notes: fa.notes,
    descriptionText: (a?.description || "").replace(/\s+/g, " ").trim().slice(0, 3000),
    extractedAt: new Date().toISOString(), model: x.model,
  });
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const groups = new Map();
for (const p of clean) { const k = `${norm(p.brand)}|${norm(p.productName)}|${p.formFactor}|${p.netQuantity || ""}`; (groups.get(k) || groups.set(k, []).get(k)).push(p); }
let dupes = 0;
for (const g of groups.values()) {
  if (g.length < 2) continue;
  g.sort((a, b) => b.confidence - a.confidence || (b.reviewCount || 0) - (a.reviewCount || 0));
  for (const d of g.slice(1)) { d.duplicateOf = g[0].key; dupes++; }
}
const final = clean.filter((p) => !p.duplicateOf);
fs.writeFileSync(path.join(D, "clean.json"), JSON.stringify(final, null, 1));
fs.writeFileSync(path.join(D, "rejects.json"), JSON.stringify(rejects, null, 1));
const v = {}, byBrand = {};
for (const p of final) { v[p.verification] = (v[p.verification] || 0) + 1; byBrand[p.brand] = (byBrand[p.brand] || 0) + 1; }
console.log(`kept ${final.length} | duplicates folded ${dupes} | rejected ${rejects.length}`, why);
console.log("verification", v);
console.log("with rating", final.filter((p) => p.rating).length, "| with review summary", final.filter((p) => p.reviewsSummary).length, "| with declaration", final.filter((p) => p.ingredientsDeclared).length);
console.log("per brand", byBrand);
