#!/usr/bin/env node
// Convert data/legacy/catalog.json (2,771 rows from the phase-2 worktree) into the new record
// shape, so snapshot v1 exists without re-paying for a single extraction.
//
// Two legacy fields have no home in the new shape and are kept rather than dropped:
//   ingredients[].agreement   the three-read majority vote. This repo reads once and checks
//                             with code, so `checks.rules` is empty for an imported row and the
//                             old vote is preserved under ingredients[].legacy.agreement.
//   ingredients[].packOverridden  what a spec graphic said before the pack photo won.
// Everything else legacy-only (amazonOffer, factsSource, priceSource, keywordClaims shape...)
// moves under a product-level `legacy` object.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION } from "../config/rules.js";
import { dataDir } from "../lib/env.js";
import { dir, readJson, nextSnapshotVersion, writeJson } from "../lib/store.js";
import { AMAZON_STORE } from "../lib/keys.js";
import { isFoodForm } from "../lib/verification.js";

/** One legacy catalog row -> one new catalog row. Pure. */
export function toNewRow(r) {
  const source = r.source || (r.store === AMAZON_STORE ? "amazon" : "shopify");
  const ingredients = (r.ingredients || []).map((g) => {
    const { agreement, packOverridden, amountUnverified, candidates, ...rest } = g;
    const legacy = {};
    if (agreement != null) legacy.agreement = agreement;
    if (packOverridden != null) legacy.packOverridden = packOverridden;
    if (amountUnverified != null) legacy.amountUnverified = amountUnverified;
    if (candidates != null) legacy.candidates = candidates;
    return { ...rest, ...(Object.keys(legacy).length ? { legacy } : {}) };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    key: r.key,
    source,
    store: r.store,
    id: r.id,
    asin: r.asin ?? null,
    url: r.url,
    title: r.title,
    vendor: r.vendor ?? null,
    brand: r.brand,
    brandRaw: r.brandRaw ?? null,
    productName: r.productName,
    productType: r.productType ?? null,
    tags: r.tags || [],

    pack: r.pack,
    formFactor: r.formFactor ?? null,
    servingSize: r.servingSize ?? null,
    servingsPerContainer: r.servingsPerContainer ?? null,
    netQuantity: r.netQuantity ?? null,
    netQuantityNote: r.netQuantityNote ?? null,
    unitsInContainer: r.unitsInContainer ?? null,
    doseDirections: r.doseDirections ?? null,

    priceMin: r.priceMin ?? null,
    priceMax: r.priceMax ?? null,
    listPrice: r.listPrice ?? null,
    priceSource: r.priceSource ?? (source === "amazon" && r.priceMin != null ? "amazon" : null),
    currency: r.currency || "INR",
    inStock: r.inStock ?? null,
    variants: r.variants || [],

    imageUrl: r.imageUrl ?? null,
    labelImages: r.labelImages || [],
    labelKinds: [],

    isFoodForm: r.isFoodForm ?? isFoodForm(r.formFactor),

    ingredients,
    confidence: r.confidence,
    verification: r.verification,
    notes: r.notes ?? null,

    // One read plus code rules replaces the three-read vote; an imported row was never checked
    // by those rules, so the list is empty rather than falsely populated.
    checks: { rules: [], textCheck: null, reread: false },

    claimedTesting: r.claimedTesting || [],
    claimedPurity: r.claimedPurity || [],
    claimedFacility: r.claimedFacility || [],
    claimedDiet: r.claimedDiet || [],
    ingredientLevelCertifications: r.ingredientLevelCertifications || [],
    keywordClaims: r.keywordClaims || [],

    packMarks: {
      testing: r.packTestingMarks || [],
      certification: r.packCertificationMarks || [],
      diet: r.packDietMarks || [],
      other: [],
      illegibleBadges: r.illegibleBadges ?? null,
    },
    allergens: r.allergens || null,
    fssaiLicences: r.fssaiLicences || [],
    certificationsRead: r.certificationsRead || { text: false, pack: false },

    ingredientsDeclared: r.ingredientsDeclared ?? null,
    rating: r.rating ?? null,
    reviewCount: r.reviewCount ?? null,
    starsBreakdown: r.starsBreakdown || null,
    reviewsSummary: r.reviewsSummary ?? null,
    reviewKeywords: r.reviewKeywords || [],
    reviewsLink: r.reviewsLink ?? null,
    bestsellerRank: r.bestsellerRank ?? null,
    monthlyPurchaseVolume: r.monthlyPurchaseVolume ?? null,
    seller: r.seller ?? null,
    dietType: r.dietType ?? null,
    countryOfOrigin: r.countryOfOrigin ?? null,

    descriptionText: r.descriptionText ?? null,
    extractedAt: r.extractedAt,
    model: r.model,
    runId: null,

    legacy: {
      importedFrom: "phase-2 worktree catalog.json",
      sources: r.sources || null,
      offers: r.offers || null,
      amazonOffer: r.amazonOffer || null,
      factsSource: r.factsSource ?? null,
      factsSourceUrl: r.factsSourceUrl ?? null,
      factsLabelImages: r.factsLabelImages || null,
      illegibleBadges: r.illegibleBadges ?? null,
    },
  };
}

function main() {
  const src = path.join(dataDir(), "legacy", "catalog.json");
  if (!fs.existsSync(src)) throw new Error(`no legacy catalog at ${src}`);
  const legacy = readJson(src, []);
  const rows = legacy.map(toNewRow);

  const snapDir = dir("snapshots");
  const v = nextSnapshotVersion(snapDir);
  const file = path.join(snapDir, `catalog-v${v}.json`);
  const body = JSON.stringify(rows, null, 1);
  fs.writeFileSync(file, body);
  fs.writeFileSync(file + ".sha256", `${crypto.createHash("sha256").update(body).digest("hex")}  catalog-v${v}.json\n`);
  writeJson(path.join(snapDir, `rejects-v${v}.json`), []);

  const tally = (fn) => rows.reduce((m, p) => ((m[fn(p)] = (m[fn(p)] || 0) + 1), m), {});
  const withLegacyVote = rows.filter((p) => p.ingredients.some((g) => g.legacy?.agreement)).length;
  console.log(`imported ${rows.length} rows from ${legacy.length} legacy rows -> ${file}`);
  console.log(`  brands ${new Set(rows.map((p) => p.brand)).size} | sources ${JSON.stringify(tally((p) => p.source))}`);
  console.log(`  verification ${JSON.stringify(tally((p) => p.verification))}`);
  console.log(`  ingredient rows ${rows.reduce((n, p) => n + p.ingredients.length, 0)} | rows carrying a legacy agreement vote on ${withLegacyVote} products`);
  console.log(`  pack-overridden products ${rows.filter((p) => p.ingredients.some((g) => g.legacy?.packOverridden)).length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
