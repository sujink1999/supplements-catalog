import test from "node:test";
import assert from "node:assert/strict";
import { RULES, checkRules, needsReread } from "../stages/check.js";

const row = (o) => ({ role: "active", printedName: "Thing", canonical: "thing", amount: 100, unit: "mg", isPartOfBlend: false, ...o });
const rec = (facts, extra = {}) => ({
  key: "s__1",
  title: "Test Product",
  labelImages: ["https://x/1.jpg"],
  facts: { productName: "Test Product", formFactor: "capsule", servingSize: "1 capsule", servingsPerContainer: 60, netQuantity: "60 capsules", confidence: 0.9, rows: [], ...facts },
  ...extra,
});

const names = (fs) => fs.map((f) => f.rule);

test("negative_amount catches the '< 0.005 g' rounding read as a negative", () => {
  const fs = RULES.negative_amount(rec({ rows: [row({ printedName: "Trans Fat", amount: -0.003, unit: "g" })] }));
  assert.deepEqual(names(fs), ["negative_amount"]);
  assert.equal(fs[0].row, 0);
  assert.equal(fs[0].severity, "reread");
});

test("absurd_amount fires over 100000 but spares enzyme and CFU units", () => {
  assert.equal(RULES.absurd_amount(rec({ rows: [row({ printedName: "Erandmool", amount: 177770, unit: "mg" })] })).length, 1);
  assert.equal(RULES.absurd_amount(rec({ rows: [row({ printedName: "Bromelain", amount: 125000, unit: "FCCPU" })] })).length, 0);
  assert.equal(RULES.absurd_amount(rec({ rows: [row({ printedName: "Protease", amount: 150000, unit: "HUT" })] })).length, 0);
  assert.equal(RULES.absurd_amount(rec({ rows: [row({ printedName: "L. acidophilus", amount: 28000000000, unit: "CFU" })] })).length, 0);
});

test("lt_rounding: a printed bound must not come back as a number", () => {
  assert.equal(RULES.lt_rounding(rec({ rows: [row({ printedName: "Cholesterol < 0.005 g", amount: 0.004, unit: "g" })] })).length, 1);
  assert.equal(RULES.lt_rounding(rec({ rows: [row({ printedName: "Cholesterol < 0.005 g", amount: null })] })).length, 0);
  assert.equal(RULES.lt_rounding(rec({ rows: [row()] })).length, 0);
});

test("missing_headline_active only applies to protein/creatine products", () => {
  const macroOnly = [row({ role: "macro", printedName: "Protein", amount: 24, unit: "g" })];
  assert.equal(RULES.missing_headline_active({ ...rec({ rows: macroOnly }), title: "Gold Whey Protein 1kg" }).length, 1);
  const withActive = [...macroOnly, row({ canonical: "whey protein isolate", amount: 24, unit: "g" })];
  assert.equal(RULES.missing_headline_active({ ...rec({ rows: withActive }), title: "Gold Whey Protein 1kg" }).length, 0);
  assert.equal(RULES.missing_headline_active({ ...rec({ rows: macroOnly }), title: "Ashwagandha Capsules" }).length, 0);
});

test("kcal_vs_macros fires past 25% and stays quiet inside it", () => {
  const macros = (kcal) => [
    row({ role: "macro", printedName: "Energy", canonical: "energy", amount: kcal, unit: "kcal" }),
    row({ role: "macro", printedName: "Protein", canonical: "protein", amount: 24, unit: "g" }),
    row({ role: "macro", printedName: "Carbohydrate", canonical: "carbohydrate", amount: 3, unit: "g" }),
    row({ role: "macro", printedName: "Total Fat", canonical: "fat", amount: 2, unit: "g" }),
  ];
  // 4*24 + 4*3 + 9*2 = 126
  assert.equal(RULES.kcal_vs_macros(rec({ rows: macros(124) })).length, 0);
  assert.equal(RULES.kcal_vs_macros(rec({ rows: macros(300) })).length, 1);
  // No energy row, nothing to compare: silence, not a finding.
  assert.equal(RULES.kcal_vs_macros(rec({ rows: [row()] })).length, 0);
});

test("per_100_unit catches the wrong column of a nutrition panel", () => {
  assert.equal(RULES.per_100_unit(rec({ rows: [row({ unit: "g/100g protein" })] })).length, 1);
  assert.equal(RULES.per_100_unit(rec({ rows: [row({ unit: "g" })] })).length, 0);
});

test("low_confidence uses the same 0.7 cutoff as the verification ladder", () => {
  assert.equal(RULES.low_confidence(rec({ confidence: 0.35 })).length, 1);
  assert.equal(RULES.low_confidence(rec({ confidence: 0.7 })).length, 0);
});

test("no_label_tile is recorded but never triggers a re-read of the same images", () => {
  const fs = RULES.no_label_tile({ ...rec({}), labelImages: [] });
  assert.equal(fs.length, 1);
  assert.equal(fs[0].severity, "note");
  assert.equal(needsReread(fs), false);
});

test("servings_vs_net_quantity compares only comparable units", () => {
  assert.equal(RULES.servings_vs_net_quantity(rec({ netQuantity: "60 capsules", servingSize: "1 capsule", servingsPerContainer: 60 })).length, 0);
  assert.equal(RULES.servings_vs_net_quantity(rec({ netQuantity: "60 capsules", servingSize: "1 capsule", servingsPerContainer: 30 })).length, 1);
  assert.equal(RULES.servings_vs_net_quantity(rec({ netQuantity: "1 kg", servingSize: "30 g", servingsPerContainer: 33 })).length, 0);
  // A count against a mass is not a contradiction, it is two different things.
  assert.equal(RULES.servings_vs_net_quantity(rec({ netQuantity: "250 g", servingSize: "1 scoop", servingsPerContainer: 25 })).length, 0);
});

test("checkRules runs every rule and a clean record produces nothing", () => {
  const clean = rec({ rows: [row({ canonical: "ashwagandha", amount: 600, unit: "mg" })] });
  assert.deepEqual(checkRules(clean), []);
  assert.equal(needsReread(checkRules(clean)), false);
  // No facts at all: nothing to check, and nothing to pay for.
  assert.deepEqual(checkRules({ key: "k", facts: null }), []);
});

test("a record with several faults reports each one", () => {
  const bad = rec({
    confidence: 0.4,
    rows: [row({ printedName: "Trans Fat", amount: -0.003, unit: "g" }), row({ printedName: "Erandmool", amount: 177770, unit: "mg" })],
  });
  const fs = checkRules(bad);
  assert.ok(fs.some((f) => f.rule === "negative_amount"));
  assert.ok(fs.some((f) => f.rule === "absurd_amount"));
  assert.ok(fs.some((f) => f.rule === "low_confidence"));
  assert.equal(needsReread(fs), true);
});
