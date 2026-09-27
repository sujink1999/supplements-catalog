import test from "node:test";
import assert from "node:assert/strict";
import { rejectReason, toRow, dedupe } from "../stages/finalize.js";

const rec = (o = {}) => ({
  key: "s.com__1",
  source: "shopify",
  store: "s.com",
  id: 1,
  url: "https://s.com/p/1",
  title: "Ashwagandha KSM-66 600mg",
  brand: "Test Brand",
  model: "gpt-6-luna",
  extractedAt: "2026-09-27T00:00:00.000Z",
  tiles: [{ index: 0, src: "https://img/0.jpg" }, { index: 1, src: "https://img/1.jpg" }],
  classify: { listing: "supplement", pack: "single", unitsInContainer: 60, labelTiles: [1], labelTileKinds: ["pack_photo"], frontTile: 0, reason: "" },
  labelImages: ["https://img/1.jpg"],
  labelKinds: ["pack_photo"],
  facts: {
    brand: "Test Brand",
    productName: "Ashwagandha",
    formFactor: "capsule",
    servingSize: "1 capsule",
    servingsPerContainer: 60,
    netQuantity: "60 Veg Capsules",
    doseDirections: "1 capsule daily",
    confidence: 0.92,
    notes: "",
    rows: [{ role: "active", printedName: "KSM-66 Ashwagandha root extract", canonical: "ashwagandha", amount: 600, unit: "mg", amountBasis: "unknown", form: "root extract", standardization: "5% withanolides", isPartOfBlend: false, blendName: null, blendTotalMg: null, source: "label_image" }],
  },
  packMarks: { testingMarks: [{ mark: "Lab Tested", kind: "third_party_lab", legible: true }, { mark: "???", kind: "other", legible: false }], certificationMarks: [{ mark: "FSSAI", legible: true }], dietMarks: ["vegetarian_green_dot"], fssaiLicences: [{ number: "10012345678901", role: "marketed_by" }], allergens: { contains: [], mayContainTraces: ["milk"], freeFrom: [], statement: "May contain traces of milk." }, otherPackMarks: [], illegibleBadgeCount: 1 },
  claims: { productTesting: [{ kind: "heavy_metals", programme: null, everyBatch: false, quote: "tested for heavy metals" }], purityClaims: [], facilityOrLicence: ["fssai"], dietFlags: ["vegetarian"], ingredientLevel: [] },
  keywordClaims: ["fssai"],
  ...o,
});

const input = (o = {}) => ({
  key: "s.com__1",
  vendor: "Test Brand",
  productType: "Supplements",
  tags: ["herbs"],
  bodyHtml: "<p>Ashwagandha, <b>lab tested</b></p>",
  variants: [
    { id: 11, title: "60 caps", price: "599.00", available: true, url: "https://s.com/p/1?v=11" },
    { id: 12, title: "120 caps", price: "999.00", available: true, url: "https://s.com/p/1?v=12" },
    { id: 13, title: "sold out", price: "499.00", available: false, url: "https://s.com/p/1?v=13" },
  ],
  ...o,
});

test("rejectReason, in the order the rules fire", () => {
  assert.equal(rejectReason(rec()), null);
  assert.equal(rejectReason(rec({ classify: { ...rec().classify, listing: "not_supplement" } })), "not_supplement");
  assert.equal(rejectReason(rec({ classify: { ...rec().classify, pack: "bundle" } })), "bundle");
  assert.equal(rejectReason(rec({ classify: { ...rec().classify, pack: "multipack" } })), "multipack");
  assert.equal(rejectReason(rec({ facts: null })), "no_facts");
  assert.equal(rejectReason(rec({ title: "Hair Growth Serum" })), "topical");
  assert.equal(rejectReason(rec({ facts: { ...rec().facts, doseDirections: "Apply to the scalp twice daily" } })), "topical");
  // A value pack is the same product in a bigger fill: kept.
  assert.equal(rejectReason(rec({ classify: { ...rec().classify, pack: "value_pack" } })), null);
});

test("no actives: rejected when a label was read or the title names a pack, kept on title alone", () => {
  const noActives = { ...rec().facts, rows: [{ role: "macro", printedName: "Energy", canonical: "energy", amount: 10, unit: "kcal" }] };
  assert.equal(rejectReason(rec({ facts: noActives })), "no_actives");
  assert.equal(rejectReason(rec({ facts: noActives, labelImages: [], title: "Immunity Combo Pack" })), "no_actives");
  assert.equal(rejectReason(rec({ facts: noActives, labelImages: [] })), null);
});

test("toRow builds the documented record", () => {
  const r = toRow(rec(), input(), { rules: [{ rule: "low_confidence", severity: "reread", row: null, detail: "x" }], textCheck: null, reread: true });
  assert.equal(r.key, "s.com__1");
  assert.equal(r.source, "shopify");
  assert.equal(r.brand, "Test Brand");
  assert.equal(r.verification, "label_read");
  assert.equal(r.isFoodForm, false);
  // Sold-out variants do not set the price range.
  assert.equal(r.priceMin, 599);
  assert.equal(r.priceMax, 999);
  assert.equal(r.priceSource, "store");
  assert.equal(r.variants.length, 2);
  // netQuantity split, front tile, label tile.
  assert.equal(r.netQuantity, "60 Veg Capsules");
  assert.equal(r.netQuantityNote, null);
  assert.equal(r.imageUrl, "https://img/0.jpg");
  assert.deepEqual(r.labelImages, ["https://img/1.jpg"]);
  // checks replaces per-row agreement.
  assert.equal(r.checks.rules.length, 1);
  assert.equal(r.checks.reread, true);
  // marks: illegible ones are dropped from the lists but counted.
  assert.deepEqual(r.packMarks.testing, [{ mark: "Lab Tested", kind: "third_party_lab" }]);
  assert.deepEqual(r.packMarks.certification, ["FSSAI"]);
  assert.equal(r.packMarks.illegibleBadges, 1);
  assert.deepEqual(r.fssaiLicences, [{ number: "10012345678901", role: "marketed_by" }]);
  assert.equal(r.allergens.mayContainTraces[0], "milk");
  assert.equal(r.claimedTesting[0].kind, "heavy_metals");
  assert.deepEqual(r.certificationsRead, { text: true, pack: true });
  assert.equal(r.descriptionText, "Ashwagandha, lab tested");
  assert.equal(r.currency, "INR");
});

test("unitsInContainer: label-derived facts beat the classify guess", () => {
  const r = toRow(rec({ classify: { ...rec().classify, unitsInContainer: 30 } }), input(), null);
  assert.equal(r.unitsInContainer, 60, "1 capsule x 60 servings, not classify's 30");
  // No parseable serving size: fall back to classify.
  const r2 = toRow(rec({ facts: { ...rec().facts, servingSize: "1 scoop" }, classify: { ...rec().classify, unitsInContainer: 30 } }), input(), null);
  assert.equal(r2.unitsInContainer, 30);
});

test("the same builder handles an Amazon row and carries its own fields", () => {
  const amz = rec({
    key: "amazon.in__B01",
    source: "amazon",
    store: "amazon.in",
    id: "B01",
    asin: "B01",
  });
  const r = toRow(amz, { key: "amazon.in__B01", variants: [{ title: "60 count", price: 499 }], meta: { price: 499, listPrice: 699, inStock: true, rating: 4.3, reviewCount: 120, ingredientsText: "Ashwagandha extract", itemForm: "Capsule", description: "d" } }, null);
  assert.equal(r.source, "amazon");
  assert.equal(r.asin, "B01");
  assert.equal(r.priceMin, 499);
  assert.equal(r.listPrice, 699);
  assert.equal(r.inStock, true);
  assert.equal(r.rating, 4.3);
  assert.equal(r.ingredientsDeclared, "Ashwagandha extract");
});

test("dedupe folds flavours of one product and keeps the best-evidenced row", () => {
  const base = { store: "s.com", brand: "B", productName: "Whey", formFactor: "powder", netQuantity: "1 kg", ingredients: [1, 2], reviewCount: 0 };
  const rows = [
    { ...base, key: "a", confidence: 0.8 },
    { ...base, key: "b", confidence: 0.95 },
    { ...base, key: "c", productName: "Creatine", confidence: 0.9 },
  ];
  const { kept, folded } = dedupe(rows);
  assert.equal(folded, 1);
  assert.deepEqual(kept.map((r) => r.key).sort(), ["b", "c"]);
  assert.equal(rows.find((r) => r.key === "a").duplicateOf, "b");
});

test("dedupe keeps different sizes of the same product apart", () => {
  const base = { store: "s.com", brand: "B", productName: "Whey", formFactor: "powder", ingredients: [], confidence: 0.9 };
  const { folded } = dedupe([{ ...base, key: "a", netQuantity: "1 kg" }, { ...base, key: "b", netQuantity: "2 kg" }]);
  assert.equal(folded, 0);
});
