// Stage 5: turn extractions into catalog rows and write a versioned snapshot.
// ONE row builder for both sources (legacy had clean.js and amazon_clean.js, ~90% identical,
// and a rule added to one silently did not apply to the other).
// Out: data/snapshots/catalog-v<N>.json + .sha256 + rejects-v<N>.json
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TOPICAL, TOPICAL_FORM, TOPICAL_DIRECTIONS, MULTI_WORD, UNIT_SERVING, SCHEMA_VERSION } from "../config/rules.js";
import { splitNetQty } from "../lib/netqty.js";
import { verificationTier, isFoodForm } from "../lib/verification.js";
import { dir, readJson, writeJson, readKeyDir, nextSnapshotVersion } from "../lib/store.js";
import { slugify } from "../lib/brands.js";
import { stripHtml } from "../lib/text.js";

/** Business-rule rejection. Returns a reason or null. Order matters: cheapest first. */
export function rejectReason(rec) {
  const c = rec.classify || {};
  const f = rec.facts;
  if (c.listing !== "supplement") return "not_supplement";
  if (c.pack === "bundle") return "bundle";
  if (c.pack === "multipack") return "multipack";
  if (!f) return "no_facts";
  if (TOPICAL.test(rec.title || "") || TOPICAL_FORM.test(f.formFactor || "") || TOPICAL_DIRECTIONS.test(f.doseDirections || "")) return "topical";
  const actives = (f.rows || []).filter((r) => r.role === "active");
  // A single product with no active rows is usually a label the model could not read, not junk:
  // keep it on the title alone. A pack/bundle title with no actives is junk.
  if (!actives.length && ((rec.labelImages || []).length || MULTI_WORD.test(rec.title || ""))) return "no_actives";
  return null;
}

const containerUnits = (facts, classify) => {
  const m = UNIT_SERVING.exec(facts.servingSize || "");
  // Label-derived facts win over the classify call's guess (issue 12).
  return facts.servingsPerContainer && m ? facts.servingsPerContainer * Number(m[1]) : (classify.unitsInContainer ?? null);
};

/**
 * One catalog row from one extraction. `input` is the filtered listing row (prices, variants,
 * Amazon meta); `checks` is the check record, or null when the stage has not run.
 */
export function toRow(rec, input, checks) {
  const f = rec.facts;
  const marks = rec.packMarks || {};
  const claims = rec.claims || {};
  const amazon = rec.source === "amazon";
  const meta = input?.meta || {};
  const actives = (f.rows || []).filter((r) => r.role === "active");
  const titleOnly = !actives.length;
  const [netQuantity, netQuantityNote] = splitNetQty(f.netQuantity);

  const variants = (input?.variants || []).filter((v) => v.available !== false && v.price != null);
  const prices = variants.map((v) => Number(v.price)).filter((n) => n > 0);

  return {
    schemaVersion: SCHEMA_VERSION,
    key: rec.key,
    source: rec.source,
    store: rec.store,
    id: rec.id,
    asin: amazon ? rec.asin ?? rec.id : null,
    url: rec.url,
    title: rec.title,
    vendor: input?.vendor || f.brand,
    brand: rec.brand || f.brand,
    brandRaw: f.brand,
    productName: f.productName,
    productType: input?.productType || null,
    tags: input?.tags || [],

    pack: rec.classify.pack,
    formFactor: f.formFactor || (meta.itemForm || "").toLowerCase() || null,
    servingSize: f.servingSize,
    servingsPerContainer: f.servingsPerContainer,
    netQuantity,
    netQuantityNote,
    unitsInContainer: containerUnits(f, rec.classify),
    doseDirections: f.doseDirections || meta.doseDirections || null,

    priceMin: prices.length ? Math.min(...prices) : (meta.price ?? null),
    priceMax: prices.length ? Math.max(...prices) : (meta.price ?? null),
    listPrice: meta.listPrice ?? null,
    priceSource: prices.length ? (amazon ? "amazon" : "store") : meta.price != null ? "amazon" : null,
    currency: "INR",
    inStock: amazon ? (meta.inStock ?? null) : prices.length > 0,
    variants: variants.map((v) => ({ id: v.id ?? rec.id, title: v.title, price: Number(v.price), url: v.url || rec.url })),

    imageUrl: rec.tiles?.[rec.classify.frontTile ?? 0]?.src || rec.tiles?.[0]?.src || null,
    labelImages: rec.labelImages || [],
    labelKinds: rec.labelKinds || [],

    // A bar is dosed like a supplement but eaten like food: flagged so a recommender can keep it
    // out of an answer about capsules without parsing the form string.
    isFoodForm: isFoodForm(f.formFactor),

    ingredients: (f.rows || []).map((r) => ({
      printedName: r.printedName,
      canonical: r.canonical,
      amount: r.amount,
      unit: r.unit,
      role: r.role,
      amountBasis: r.amountBasis,
      form: r.form,
      standardization: r.standardization,
      isPartOfBlend: r.isPartOfBlend,
      blendName: r.blendName,
      blendTotalMg: r.blendTotalMg,
      source: r.source,
      ...(r.flagged ? { flagged: r.flagged } : {}),
    })),
    confidence: f.confidence,
    verification: verificationTier({ titleOnly, hasLabel: (rec.labelImages || []).length > 0, lowResLabel: Boolean(f.lowResLabel), confidence: f.confidence }),
    notes: f.notes,

    // `agreement` per row is gone: one read plus code rules plus an optional text check,
    // recorded here instead.
    checks: {
      rules: checks?.rules || [],
      textCheck: checks?.textCheck || null,
      reread: Boolean(rec.reread || checks?.reread),
    },

    // What the listing text claims, judged in call 1.
    claimedTesting: (claims.productTesting || []).map((t) => ({ kind: t.kind, programme: t.programme, everyBatch: t.everyBatch, quote: t.quote })),
    claimedPurity: claims.purityClaims || [],
    claimedFacility: claims.facilityOrLicence || [],
    claimedDiet: claims.dietFlags || [],
    ingredientLevelCertifications: claims.ingredientLevel || [],
    keywordClaims: rec.keywordClaims || [],

    // What is printed on the pack, read in call 2.
    packMarks: {
      testing: (marks.testingMarks || []).filter((m) => m.legible).map((m) => ({ mark: m.mark, kind: m.kind })),
      certification: (marks.certificationMarks || []).filter((m) => m.legible).map((m) => m.mark),
      diet: marks.dietMarks || [],
      other: marks.otherPackMarks || [],
      illegibleBadges: marks.illegibleBadgeCount ?? null,
    },
    allergens: marks.allergens || null,
    fssaiLicences: marks.fssaiLicences || [],
    certificationsRead: { text: Boolean(claims.productTesting), pack: Boolean(rec.packMarks) },

    // Amazon-only signals.
    ingredientsDeclared: meta.ingredientsText || null,
    rating: meta.rating ?? null,
    reviewCount: meta.reviewCount ?? null,
    starsBreakdown: meta.starsBreakdown || null,
    reviewsSummary: meta.reviewsSummary || null,
    reviewKeywords: meta.reviewKeywords || [],
    reviewsLink: meta.reviewsLink || null,
    bestsellerRank: meta.bestsellerRank || null,
    monthlyPurchaseVolume: meta.monthlyPurchaseVolume || null,
    seller: meta.seller || null,
    dietType: meta.dietType || null,
    countryOfOrigin: meta.countryOfOrigin || null,

    descriptionText: stripHtml(input?.bodyHtml || meta.description || "").slice(0, 3000),
    extractedAt: rec.extractedAt,
    model: rec.model,
    runId: rec.runId ?? null,
  };
}

/** Same product in two flavours or sizes: keep the best-evidenced row, mark the rest. */
export function dedupe(rows) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const groups = new Map();
  for (const p of rows) {
    const k = `${p.store}|${norm(p.brand)}|${norm(p.productName)}|${p.formFactor}|${p.netQuantity || ""}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  let folded = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => b.confidence - a.confidence || b.ingredients.length - a.ingredients.length || (b.reviewCount || 0) - (a.reviewCount || 0));
    for (const d of g.slice(1)) {
      d.duplicateOf = g[0].key;
      folded++;
    }
  }
  return { kept: rows.filter((p) => !p.duplicateOf), duplicates: rows.filter((p) => p.duplicateOf), folded };
}

/** Build rows from every extraction on disk for the given brands (all brands when omitted). */
export function build({ brands = null } = {}) {
  const filtered = dir("filtered");
  const inputs = new Map();
  for (const f of fs.readdirSync(filtered)) {
    if (!f.endsWith(".json") || f.endsWith(".dropped.json")) continue;
    if (brands && !brands.includes(f.slice(0, -5))) continue;
    for (const row of readJson(path.join(filtered, f), [])) inputs.set(row.key, row);
  }
  const checks = readKeyDir(dir("checks"));
  const extractions = readKeyDir(dir("extract"));

  const rows = [];
  const rejects = [];
  const why = {};
  for (const [key, rec] of Object.entries(extractions)) {
    if (!inputs.has(key)) continue;
    const reason = rejectReason(rec);
    if (reason) {
      why[reason] = (why[reason] || 0) + 1;
      rejects.push({ key, reason, title: rec.title });
      continue;
    }
    rows.push(toRow(rec, inputs.get(key), checks[key] || null));
  }
  return { rows, rejects, why };
}

export function run({ brand = null, log = console.log } = {}) {
  const { rows, rejects, why } = build({ brands: brand ? [slugify(brand)] : null });
  const { kept, folded } = dedupe(rows);

  const snapDir = dir("snapshots");
  const v = nextSnapshotVersion(snapDir);
  const file = path.join(snapDir, `catalog-v${v}.json`);
  const body = JSON.stringify(kept, null, 1);
  fs.writeFileSync(file, body);
  fs.writeFileSync(file + ".sha256", `${crypto.createHash("sha256").update(body).digest("hex")}  catalog-v${v}.json\n`);
  writeJson(path.join(snapDir, `rejects-v${v}.json`), rejects);

  const tally = (fn) => kept.reduce((m, p) => ((m[fn(p)] = (m[fn(p)] || 0) + 1), m), {});
  const brands = new Set(kept.map((p) => p.brand));
  log(`snapshot v${v}: ${kept.length} products, ${brands.size} brands, ${folded} duplicates folded, ${rejects.length} rejected ${JSON.stringify(why)}`);
  log(`  verification ${JSON.stringify(tally((p) => p.verification))}`);
  log(`  ingredient rows ${kept.reduce((n, p) => n + p.ingredients.length, 0)} | with a price ${kept.filter((p) => p.priceMin != null).length} | with allergens ${kept.filter((p) => p.allergens).length} | bars ${kept.filter((p) => p.isFoodForm).length}`);
  log(`  ${file}`);
  return { version: v, file, kept, rejects };
}
