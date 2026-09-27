// The prompts are the most expensive thing in the repo to get wrong: each rule below was paid
// for with a real misread. These assertions fail if anyone paraphrases one.
import test from "node:test";
import assert from "node:assert/strict";
import { call1, call2, CLASSIFY_SYS, CLAIMS_SYS, FACTS_SYS, MARKS_SYS, CLASSIFY_KEYS, CLAIMS_KEYS, FACTS_KEYS, MARKS_KEYS, pick } from "../lib/prompts.js";

const verbatim = {
  "extract2 CLASSIFY_SYS: bars": 'A protein bar IS a supplement when it is sold for a stated protein dose (the title or pack names the grams, e.g. "20g Protein Bar"): treat it as a supplement with formFactor "bar".',
  "extract2 CLASSIFY_SYS: ayurvedic liquids": "Judge by dose, not by container: a 1 L bottle taken 30 ml at a time is a supplement; a drink consumed by the glass is not.",
  "extract2 CLASSIFY_SYS: sachets are single": 'NOTE "Pack of 30 sachets/sticks/shots/gummies" is a SINGLE product whose container holds 30 single-dose units; report that count in unitsInContainer.',
  "extract2 CLASSIFY_SYS: bundle from title": "Every name you put in bundleComponents MUST appear in the title or a variant name; if you cannot name two distinct products from that text, the listing is single.",
  "extract2 CLASSIFY_SYS: spec graphic distinction": "Brands routinely publish a spec graphic whose numbers disagree with the pack they actually ship, so this distinction decides which numbers we keep.",
  "extract2 FACTS_SYS: pack wins": "The photographed physical pack ALWAYS wins over a flat rendered spec graphic: the pack is what ships.",
  "extract2 FACTS_SYS: group totals": "NEVER copy the group total onto each member.",
  "extract2 FACTS_SYS: percentages": 'Report it as printed: amount 7, unit "%". NEVER convert a percentage into grams or milligrams yourself, even when the serving size is known - a converted number is not what the label says.',
  "extract2 FACTS_SYS: headline nutrient": "Protein powders / gainers / creatine / electrolytes: the headline nutrient IS the active.",
  "extract2 FACTS_SYS: blends": "Never collapse a blend into one row.",
  "extract2 FACTS_SYS: no label photo": "If no label photo was provided, work from text only and cap confidence at 0.5.",
  "certs_llm SYS: ingredient level": '("KSM-66 has USP and NSF certifications") is ingredientLevel, not the product\'s.',
  "certs_llm SYS: testing vs purity": '"Tested for X" is testing. "Free from X" or "no X" is a purity claim, not testing. Keep them apart.',
  "certs_llm SYS: licence is not a test": "A licence or registration is not a quality test: FSSAI, AYUSH, ISO and GMP describe the factory or the legal listing.",
  "certs_llm SYS: spiking": "Record those as protein_spiking and protein_accuracy, not as generic third_party_lab.",
  "certs_llm SYS: empty is fine": "Return only what the text supports. Empty lists are the right answer for most listings.",
  "marks SYS: never infer": "Read what is printed. Never infer a mark from the brand, the product type or the design, and never guess text that is too small or blurred — mark that legible:false instead.",
  "marks SYS: two licences": "A pack often prints an FSSAI licence for the marketer and another for the manufacturer; record both with their role rather than picking one.",
  "marks SYS: allergen kinds": "what the product CONTAINS (\"Contains Milk\", \"Contains Soy\") and what the SHARED FACILITY may introduce",
};

test("every legacy rule sentence survives verbatim in the assembled prompts", () => {
  const both = call1.system + "\n" + call2.system;
  for (const [what, sentence] of Object.entries(verbatim)) {
    assert.ok(both.includes(sentence), `lost: ${what}`);
  }
});

test("call 1 is classify + claims, call 2 is facts + marks, each block unmodified", () => {
  assert.ok(call1.system.startsWith(CLASSIFY_SYS));
  assert.ok(call1.system.endsWith(CLAIMS_SYS));
  assert.ok(call2.system.startsWith(FACTS_SYS));
  assert.ok(call2.system.endsWith(MARKS_SYS));
  // No block leaks into the other call.
  assert.ok(!call1.system.includes(FACTS_SYS));
  assert.ok(!call2.system.includes(CLASSIFY_SYS));
});

test("both schemas are strict: every property required, no extras", () => {
  for (const c of [call1, call2]) {
    assert.equal(c.schema.type, "object");
    assert.equal(c.schema.additionalProperties, false);
    assert.deepEqual(c.schema.required, Object.keys(c.schema.properties), `${c.name} must require every property`);
  }
});

test("call 1 schema = CLASSIFY_SCHEMA plus the certs_llm claims fields", () => {
  const props = Object.keys(call1.schema.properties);
  for (const k of ["listing", "pack", "unitsInContainer", "bundleComponents", "labelTiles", "labelTileKinds", "frontTile", "reason"]) assert.ok(props.includes(k), k);
  for (const k of ["productTesting", "purityClaims", "facilityOrLicence", "dietFlags", "ingredientLevel"]) assert.ok(props.includes(k), k);
  assert.equal(call1.schema.properties.productTesting.items.properties.kind.enum.length, 16);
  assert.ok(call1.schema.properties.productTesting.items.properties.kind.enum.includes("protein_spiking"));
  assert.equal(call1.schema.properties.facilityOrLicence.items.enum.length, 15);
});

test("call 2 schema = FACTS_SCHEMA plus the marks fields", () => {
  const props = Object.keys(call2.schema.properties);
  for (const k of ["brand", "productName", "formFactor", "servingSize", "servingsPerContainer", "netQuantity", "doseDirections", "rows", "confidence", "notes"]) assert.ok(props.includes(k), k);
  for (const k of ["testingMarks", "certificationMarks", "dietMarks", "fssaiLicences", "allergens", "otherPackMarks", "illegibleBadgeCount"]) assert.ok(props.includes(k), k);
});

test("formFactor's enum description lists bar, or bars silently become 'other'", () => {
  // Issue 53: the omission was a silent misclassification, not an error.
  assert.match(call2.schema.properties.formFactor.description, /\bbar\b/);
});

test("the allergen split is modelled, not merged", () => {
  const a = call2.schema.properties.allergens.properties;
  assert.ok(a.contains && a.mayContainTraces && a.freeFrom && a.statement);
  assert.deepEqual(a.contains.items.enum, a.mayContainTraces.items.enum);
});

test("pick splits one merged output back into its two sections", () => {
  const out = { listing: "supplement", pack: "single", purityClaims: ["no added sugar"], dietFlags: [] };
  assert.deepEqual(pick(out, CLASSIFY_KEYS), { listing: "supplement", pack: "single" });
  assert.deepEqual(pick(out, CLAIMS_KEYS), { purityClaims: ["no added sugar"], dietFlags: [] });
  assert.deepEqual(pick(null, FACTS_KEYS), {});
  assert.ok(MARKS_KEYS.includes("fssaiLicences"));
});
