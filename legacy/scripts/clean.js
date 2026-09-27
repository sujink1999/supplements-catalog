#!/usr/bin/env node
// Post-process bulk extractions into one clean product list.
// Keeps supplement singles/value packs with facts; drops bundles, multipacks, non-supplements, topicals.
// Output: scripts/e2e/out/products/bulk/clean.json + rejects.json + console summary.
const fs = require("fs"), path = require("path");
const DIR = path.join(__dirname, "../../e2e/out/products/bulk");
const inputById = new Map(JSON.parse(fs.readFileSync(path.join(DIR, "input.json"))).map((r) => [`${r.store}__${r.id}`, r]));
// Three-read adjudication (adjudicate.js) overrides the first read wherever it ran:
// majority value where two reads agree, amount nulled where none do.
const ADJ = fs.existsSync(path.join(DIR, "adjudicated.json")) ? JSON.parse(fs.readFileSync(path.join(DIR, "adjudicated.json"))) : {};
// Products whose own photos had no readable panel, re-read from the same product's Amazon
// listing (fill_apply.js). The Shopify listing stays the product of record; only the facts
// are borrowed, and factsSource records that.
const FILL = fs.existsSync(path.join(DIR, "fill_patch.json")) ? JSON.parse(fs.readFileSync(path.join(DIR, "fill_patch.json"))) : {};
// Testing and certification CLAIMS scraped from the listing text (certs.js). These are what
// the seller says, never something we verified, so they are stored under claimedCertifications.
const CERTS = fs.existsSync(path.join(DIR, "certs_patch.json")) ? JSON.parse(fs.readFileSync(path.join(DIR, "certs_patch.json"))) : {};
// Three separate layers, never merged into one "certified" flag:
//   judged   — the listing text, read by a model that separates the product's own testing
//              from an ingredient's, and testing from "free from" (certs_llm.js)
//   marks    — what is actually printed on the pack, which listings routinely omit (marks.js)
//   regex    — the original keyword hits, kept only as a fallback where judging never ran
const readDir = (dir) => {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try { out[f.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(dir, f))); } catch {}
  }
  return out;
};
const JUDGED = readDir(path.join(DIR, "certs_judged"));
const MARKS = readDir(path.join(DIR, "marks"));
const PRICES = fs.existsSync(path.join(DIR, "price_patch.json")) ? JSON.parse(fs.readFileSync(path.join(DIR, "price_patch.json"))) : {};
const TOPICAL = /\b(serum|cream|lotion|shampoo|conditioner|gel\b|balm|face wash|body wash|scrub|mask|hair oil|massage oil|roll-?on|spray|patch|toothpaste|mouthwash|soap|wax|topical|for (hair|skin|face|scalp) (oil|application))\b/i;
const TOPICAL_FORM = /^(cream|serum|gel|lotion|oil_topical|topical|spray)$/i;
// One store = one brand for these single-brand D2C shops. The vendor/brand field on the row
// is free text and comes back in up to five spellings per store ("BigMuscles Nutrition",
// "Big Muscles Nutrition", "BM Wellness"), and sometimes holds a category instead of a brand.
// Two spellings of one product otherwise survive deduplication as two products.
const STORE_BRAND = {
  "aceblend.com": "Ace Blend", "beastlife.in": "Beastlife", "bigmusclesnutrition.com": "BigMuscles Nutrition",
  "cureveda.com": "Cureveda", "healthyhey.com": "HealthyHey Nutrition", "in.fastandup.com": "Fast&Up",
  "inlifehealthcare.com": "INLIFE", "miduty.in": "Miduty", "mycf.in": "Carbamide Forte",
  "nakpro.com": "Nakpro Nutrition", "naturyz.in": "Naturyz", "neuherbs.com": "Neuherbs",
  "originnutrition.in": "Origin Nutrition", "oziva.in": "OZiva", "setu.in": "Setu Nutrition",
  "steadfastnutrition.in": "Steadfast Nutrition", "thehimalayanorganics.in": "Vlado's Himalayan Organics",
  "unived.com": "Unived", "wellbeingnutrition.com": "Wellbeing Nutrition", "zeroharm.in": "ZeroHarm",
  "thesirona.com": "Sirona", "boldfit.com": "Boldfit",
  "cosmix.in": "Cosmix", "decodeage.com": "Decode Age", "thestack.club": "The Stack Club",
  "purenutrition.in": "Pure Nutrition", "traya.health": "Traya", "nveda.in": "Nveda",
  "www.gynoveda.com": "Gynoveda", "melblok.com": "Melblok",
  "www.yogabars.in": "Yoga Bar", "superyou.in": "SuperYou", "maxprotein.in": "Max Protein",
};
// Genuine separate brands sold inside another brand's store, matched on the row's own text.
const SUB_BRANDS = [
  [/chicnutrix/i, "Chicnutrix"], [/palaknots/i, "PalakNots"], [/gainwell/i, "GainWell"],
  [/healthyhey\s*sports/i, "HealthyHey Sports"], [/bm\s*wellness/i, "BM Wellness"], [/ovegha/i, "Ovegha"],
];
// `raw` is a haystack of vendor + label brand + title, used only for sub-brand detection.
// The fallback must never be that haystack, or the brand becomes the product title.
const brandOf = (store, raw, vendor, labelBrand) => {
  for (const [re, name] of SUB_BRANDS) if (re.test(raw || "")) return name;
  if (STORE_BRAND[store]) return STORE_BRAND[store];
  const v = (vendor || "").trim(), l = (labelBrand || "").trim();
  return v || l || null;
};
// The model sometimes answers netQuantity with its reasoning attached
// ("10 sachets (listing tiles indicate 10; label photo shows ... no full pack count)").
// Keep the measured value in the field and move the caveat to its own note.
const UNIT = "kg|g|gm|gms|grams?|mg|mcg|ml|l|litres?|liters?|sachets?|sticks?|strips?|capsules?|caps?|tablets?|tabs?|softgels?|gummies|gummy|servings?|scoops?|shots?|vials?|pcs?|pieces?|N";
// Optional "pack of", an optional "5 x " multiplier, a number, optional descriptors
// ("Veg", "vegetable", "chewable"), then the unit. Anything after that is commentary.
const NQ = new RegExp(
  "^\\s*\\(?\\s*(?:pack\\s+of\\s+)?" +
  "(?:\\d+(?:[.,]\\d+)?\\s*(?:x|×)\\s*)?" +
  "\\d+(?:[.,]\\d+)?(?:'s)?" +
  "(?:\\s*(?:x|×)\\s*\\d+(?:[.,]\\d+)?)?" +
  "\\s*(?:[a-z]{2,12}\\.?\\s+){0,2}" +
  "(?:" + UNIT + ")?\\b\\.?", "i");
// A trailing total such as ") = 169 g" belongs to the value, not the commentary.
const NQ_TOTAL = new RegExp("^\\s*\\)?\\s*=\\s*\\d+(?:[.,]\\d+)?\\s*(?:" + UNIT + ")\\b", "i");
const splitNetQty = (raw) => {
  if (!raw) return [null, null];
  const v = String(raw).trim();
  // Strip a leading "Net wt", "Net weight", "For" before matching.
  const lead = v.replace(/^\s*(?:net\s*(?:wt\.?|weight)|total\s*qty|box\s*of|bottle\s*of|jar\s*of|for)\s*[:\-]?\s*/i, "");
  const m = lead.match(NQ);
  if (m) {
    let take = m[0].length;
    const t = lead.slice(take).match(NQ_TOTAL);
    if (t) take += t[0].length;
    const value = lead.slice(0, take).replace(/^[\s(]+/, "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
    let rest = lead.slice(take).replace(/^[\s;,.()=-]+/, "").replace(/[()]/g, "").trim();
    // "60N Tablets" splits into value "60N" and remainder "Tablets": a bare unit word
    // belongs to the value, not to a caveat note.
    if (/^(?:veg\.?\s*)?(?:tablets?|capsules?|softgels?|sachets?|sticks?|gummies|servings?|scoops?|shots?|ml|g|gm|grams?|kg)\.?$/i.test(rest)) {
      return [(value + " " + rest).trim(), null];
    }
    return [value || null, rest || null];
  }
  if (!m) return [null, v];
  let take = m[0].length;
  const tail = v.slice(take).match(NQ_TOTAL);
  if (tail) take += tail[0].length;
  const value = v.slice(0, take).replace(/^[\s(]+/, "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
  const rest = v.slice(take).replace(/^[\s;,.()=-]+/, "").replace(/[()]/g, "").trim();
  return [value || null, rest || null];
};
const clean = [], rejects = [];
const why = {};
const rej = (key, reason, extra) => { why[reason] = (why[reason] || 0) + 1; rejects.push({ key, reason, ...extra }); };
// read3/ is the current read (it prefers the photographed pack over a spec graphic and
// reports percentages as printed); extracted/ is the older one, still the only read for
// products that predate read3. Union of both, read3 winning.
const SRC = new Map();
for (const dir of ["extracted", "read3"]) {
  const d = path.join(DIR, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((f) => f.endsWith(".json"))) SRC.set(f, dir);
}
for (const [f, dir] of SRC) {
  const key = f.replace(".json", "");
  const x = JSON.parse(fs.readFileSync(path.join(DIR, dir, f)));
  const src = inputById.get(key);
  const c = x.classify, fa = x.facts;
  if (c.listing !== "supplement") { rej(key, "not_supplement", { title: x.title }); continue; }
  if (c.pack === "bundle") { rej(key, "bundle", { title: x.title }); continue; }
  if (c.pack === "multipack") { rej(key, "multipack", { title: x.title }); continue; }
  if (!fa) { rej(key, "no_facts", { title: x.title }); continue; }
  const text = `${x.title} ${src?.productType || ""} ${fa.doseDirections || ""}`;
  if (TOPICAL.test(x.title) || TOPICAL_FORM.test(fa.formFactor || "") || /apply (to|on) (the )?(skin|scalp|hair|face)/i.test(fa.doseDirections || "")) { rej(key, "topical", { title: x.title }); continue; }
  if (ADJ[key]) fa.rows = ADJ[key];
  const fill = FILL[key];
  if (fill) {
    fa.rows = fill.ingredients;
    fa.servingSize = fill.servingSize ?? fa.servingSize;
    fa.servingsPerContainer = fill.servingsPerContainer ?? fa.servingsPerContainer;
    fa.netQuantity = fill.netQuantity ?? fa.netQuantity;
    fa.doseDirections = fill.doseDirections ?? fa.doseDirections;
    fa.formFactor = fill.formFactor ?? fa.formFactor;
    fa.confidence = fill.confidence;
    fa.notes = `Facts read from this product's Amazon listing, not the store's own photos. ${fill.notes || ""}`;
    fa.lowResLabel = false;
  }
  const actives = fa.rows.filter((r) => r.role === "active");
  // A single product with no active rows is usually a label the model could not read, not junk.
  // Keep it if the title reads like one product: the name alone still lets the LLM find it.
  let titleOnly = false;
  if (!actives.length) {
    const multiWord = /\b(pack|bundle|combo|kit|stack)\b/i.test(x.title);
    if (x.labelImages.length || multiWord) { rej(key, "no_actives", { title: x.title }); continue; }
    titleOnly = true; why.kept_title_only = (why.kept_title_only || 0) + 1;
  }
  const hasLabel = x.labelImages.length > 0;
  const verification = fill ? fill.verification : titleOnly ? "unverified_title_only" : !hasLabel ? "unverified_no_label" : fa.lowResLabel ? "unverified_low_res" : fa.confidence < 0.7 ? "unverified_low_confidence" : "label_read";
  // container count: label-derived facts win over the classify guess
  const units = fa.servingsPerContainer && /^\s*(\d+)\s*(capsule|tablet|softgel|gummy|gummies|sachet|stick|strip)/i.test(fa.servingSize || "")
    ? fa.servingsPerContainer * Number(RegExp.$1) : c.unitsInContainer;
  const variants = (src?.variants || []).filter((v) => v.available !== false);
  const prices = variants.map((v) => Number(v.price)).filter((n) => n > 0);
  clean.push({
    key, store: x.store, id: x.id, url: x.url, title: x.title, vendor: src?.vendor || fa.brand, brand: brandOf(x.store, `${src?.vendor || ""} ${fa.brand || ""} ${x.title}`, src?.vendor, fa.brand), brandRaw: fa.brand, productName: fa.productName,
    productType: src?.productType || null, tags: src?.tags || [],
    pack: c.pack, formFactor: fa.formFactor, servingSize: fa.servingSize, servingsPerContainer: fa.servingsPerContainer, netQuantity: splitNetQty(fa.netQuantity)[0], netQuantityNote: splitNetQty(fa.netQuantity)[1], unitsInContainer: units,
    doseDirections: fa.doseDirections,
    priceMin: prices.length ? Math.min(...prices) : (PRICES[key]?.price ?? null),
    priceMax: prices.length ? Math.max(...prices) : (PRICES[key]?.price ?? null),
    priceSource: prices.length ? "store" : PRICES[key] ? "amazon" : null,
    amazonOffer: PRICES[key] ? { asin: PRICES[key].asin, url: PRICES[key].url, price: PRICES[key].price, listPrice: PRICES[key].listPrice, inStock: PRICES[key].inStock } : null,
    rating: PRICES[key]?.rating ?? null, reviewCount: PRICES[key]?.reviewCount ?? null, reviewsSummary: PRICES[key]?.reviewsSummary ?? null,
    currency: "INR",
    variants: variants.map((v) => ({ id: v.id, title: v.title, price: Number(v.price), url: v.url })),
    imageUrl: x.tiles[c.frontTile ?? 0]?.src || x.tiles[0]?.src || null, labelImages: x.labelImages,
    // A bar is dosed like a supplement but eaten like food: flagged so a recommender can
    // keep it out of an answer about capsules without having to parse the form string.
    isFoodForm: fa.formFactor === "bar",
    ingredients: fa.rows, confidence: fa.confidence, verification, notes: fa.notes,
    // What the listing text claims, judged
    claimedTesting: (JUDGED[key]?.productTesting || []).map((t) => ({ kind: t.kind, programme: t.programme, everyBatch: t.everyBatch, quote: t.quote })),
    claimedPurity: JUDGED[key]?.purityClaims || [],
    claimedFacility: JUDGED[key]?.facilityOrLicence || [],
    claimedDiet: JUDGED[key]?.dietFlags || [],
    ingredientLevelCertifications: JUDGED[key]?.ingredientLevel || [],
    // What is printed on the pack
    packTestingMarks: (MARKS[key]?.testingMarks || []).filter((m) => m.legible).map((m) => ({ mark: m.mark, kind: m.kind })),
    packCertificationMarks: (MARKS[key]?.certificationMarks || []).filter((m) => m.legible).map((m) => m.mark),
    packDietMarks: MARKS[key]?.dietMarks || [],
    allergens: MARKS[key]?.allergens || null,
    fssaiLicences: MARKS[key]?.fssaiLicences || [],
    illegibleBadges: MARKS[key]?.illegibleBadgeCount ?? null,
    certificationsRead: { text: Boolean(JUDGED[key]), pack: Boolean(MARKS[key]) },
    // superseded keyword pass, kept where nothing better ran
    keywordClaims: (CERTS[key] || {}).claims || [],
    factsSource: fill ? "amazon" : "store", factsSourceUrl: fill ? fill.factsSourceUrl : x.url,
    factsLabelImages: fill ? fill.factsLabelImages : x.labelImages,
    descriptionText: (src?.bodyHtml || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000),
    extractedAt: new Date().toISOString(), model: x.model,
  });
}
// dedupe: same store + same normalised productName+formFactor → keep highest-confidence, list the rest as duplicates
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const groups = new Map();
for (const p of clean) { const k = `${p.store}|${norm(p.brand)}|${norm(p.productName)}|${p.formFactor}`; (groups.get(k) || groups.set(k, []).get(k)).push(p); }
let dupes = 0;
for (const g of groups.values()) { if (g.length < 2) continue; g.sort((a, b) => b.confidence - a.confidence || b.ingredients.length - a.ingredients.length); for (const d of g.slice(1)) { d.duplicateOf = g[0].key; dupes++; } }
const final = clean.filter((p) => !p.duplicateOf);
fs.writeFileSync(path.join(DIR, "clean.json"), JSON.stringify(final, null, 1));
fs.writeFileSync(path.join(DIR, "rejects.json"), JSON.stringify(rejects, null, 1));
const v = {}; for (const p of final) v[p.verification] = (v[p.verification] || 0) + 1;
const byStore = {}; for (const p of final) byStore[p.store] = (byStore[p.store] || 0) + 1;
console.log("kept", final.length, "| flavour/size duplicates folded", dupes, "| rejected", rejects.length, why);
console.log("verification", v);
console.log("per store", byStore);
