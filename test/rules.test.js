import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NON_SUPP, GEAR, FOOD, TOPICAL, TOPICAL_FORM, NON_FORM } from "../config/rules.js";
import { dropReason, toInputShopify, toInputAmazon } from "../stages/filter.js";
import { scanClaims, claimExcerpt, stripHtml } from "../lib/text.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const rawShopify = JSON.parse(fs.readFileSync(path.join(here, "fixtures/shopify-raw.json"), "utf8"));

test("NON_SUPP keeps the clause sample.js had dropped", () => {
  // sample.js's copy was missing `oil\b.*(hair|face|skin|body)`; the union keeps it.
  assert.ok(NON_SUPP.test("Rosemary Oil for Hair Growth"));
  assert.ok(NON_SUPP.test("Stainless Steel Shaker Bottle"));
  assert.ok(!NON_SUPP.test("Omega 3 Fish Oil Softgels"));
});

test("gear, food and topical regexes separate the three drop classes", () => {
  assert.ok(GEAR.test("Resistance Band Set"));
  assert.ok(FOOD.test("Crunchy Peanut Butter 1kg"));
  assert.ok(TOPICAL.test("Anti Hairfall Shampoo"));
  // A dosed protein bar must survive all three: it is a supplement (owner's scope decision).
  assert.ok(!GEAR.test("20g Protein Bar"));
  assert.ok(!FOOD.test("20g Protein Bar"));
  assert.ok(!TOPICAL.test("20g Protein Bar"));
  // ...while a snack bar is food.
  assert.ok(FOOD.test("Choco Almond Snack Bar"));
});

test("TOPICAL_FORM and NON_FORM match form values, not titles", () => {
  assert.ok(TOPICAL_FORM.test("serum"));
  assert.ok(TOPICAL_FORM.test("oil_topical"));
  assert.ok(!TOPICAL_FORM.test("softgel"));
  assert.ok(NON_FORM.test("Band"));
  assert.ok(!NON_FORM.test("capsule"));
});

test("dropReason: no-image and off-brand", () => {
  assert.equal(dropReason({ title: "Magnesium Glycinate", images: [] }), "no_image");
  assert.equal(dropReason({ title: "Whey Protein", brand: "Random", images: [{ src: "x" }] }, { aliases: ["muscleblaze"] }), "off_brand");
  assert.equal(dropReason({ title: "MuscleBlaze Whey", brand: "MuscleBlaze", images: [{ src: "x" }] }, { aliases: ["muscleblaze"] }), null);
  // Amazon's own item-form attribute is enough on its own.
  assert.equal(dropReason({ title: "Grip Trainer Pro", itemForm: "Band", images: [{ src: "x" }] }), "gear");
});

test("dropReason keeps real supplements from a real store pull", () => {
  const berberine = rawShopify.find((r) => /Berberine/.test(r.title));
  assert.equal(dropReason(berberine), null);
});

test("toInputShopify / toInputAmazon build the extractor shape and the right key", () => {
  const s = toInputShopify(rawShopify[0], "Ace Blend");
  assert.equal(s.key, `aceblend.com__${rawShopify[0].id}`);
  assert.equal(s.source, "shopify");
  assert.equal(s.brand, "Ace Blend");
  assert.ok(Array.isArray(s.images) && s.images[0].src);

  const a = toInputAmazon({ asin: "B00KDFRUGY", url: "u", title: "t", brand: "MuscleBlaze", price: 499, images: ["i1"], features: ["f"], description: "d", ingredientsText: "ing", rating: 4.2 }, "MuscleBlaze");
  assert.equal(a.key, "amazon.in__B00KDFRUGY");
  assert.equal(a.store, "amazon.in");
  assert.match(a.bodyHtml, /d — ing — f/);
  // Amazon-only signals survive for the finalizer, not the extractor.
  assert.equal(a.meta.rating, 4.2);
});

test("scanClaims records the licence once and never double-counts fssai", () => {
  const r = scanClaims("FSSAI Licence No. 10012345678901. Third party tested. 100% Vegan.");
  assert.equal(r.fssaiLicence, "10012345678901");
  assert.equal(r.claims.filter((c) => c === "fssai").length, 1);
  assert.ok(r.claims.includes("third_party_tested"));
  assert.ok(r.claims.includes("vegan"));
});

test("claimExcerpt windows a long unpunctuated block instead of dropping it", () => {
  const block = "x".repeat(400) + " lab tested " + "y".repeat(400);
  const out = claimExcerpt(block);
  assert.ok(out.includes("lab tested"));
  assert.ok(out.length < block.length);
  assert.equal(claimExcerpt("Just a nice tasting powder."), "");
});

test("stripHtml flattens markup and entities", () => {
  assert.equal(stripHtml("<p>Hello&nbsp;<b>world</b></p>"), "Hello world");
});
