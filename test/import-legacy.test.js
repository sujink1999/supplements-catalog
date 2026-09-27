import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { toNewRow } from "../bin/import-legacy.js";
import { SCHEMA_VERSION } from "../config/rules.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const rows = JSON.parse(fs.readFileSync(path.join(here, "fixtures/legacy-rows.json"), "utf8"));
const out = rows.map(toNewRow);

test("every fixture row converts and keeps its key and identity", () => {
  assert.equal(out.length, rows.length);
  for (const [i, r] of out.entries()) {
    assert.equal(r.key, rows[i].key);
    assert.equal(r.schemaVersion, SCHEMA_VERSION);
    assert.equal(r.brand, rows[i].brand);
    assert.equal(r.verification, rows[i].verification);
    assert.equal(r.ingredients.length, rows[i].ingredients.length);
  }
});

test("source is always set, including for the Shopify rows that had it null", () => {
  for (const r of out) assert.ok(r.source === "shopify" || r.source === "amazon");
  const amz = out.find((r) => r.store === "amazon.in");
  assert.equal(amz.source, "amazon");
  const shop = out.find((r) => r.store !== "amazon.in");
  assert.equal(shop.source, "shopify");
  // The Shopify cleaner never set `source` at all, so it is absent, not "shopify".
  assert.ok(rows.find((r) => r.key === shop.key).source == null, "the legacy Shopify row carried no source");
});

test("agreement becomes checks.rules empty, and is preserved per row under legacy", () => {
  for (const r of out) {
    assert.deepEqual(r.checks, { rules: [], textCheck: null, reread: false });
    for (const g of r.ingredients) assert.equal(g.agreement, undefined, "agreement must not stay at the top of the row");
  }
  const voted = out.flatMap((r) => r.ingredients).filter((g) => g.legacy?.agreement);
  assert.ok(voted.length > 0, "the fixture must contain at least one voted row");
  assert.ok(["1/1", "2/2", "2/3", "pack", "none"].includes(voted[0].legacy.agreement));
});

test("packOverridden is kept in the row's legacy sub-object, not dropped", () => {
  const src = rows.flatMap((r) => r.ingredients).filter((g) => g.packOverridden);
  assert.ok(src.length > 0, "the fixture must contain a pack-overridden row");
  const kept = out.flatMap((r) => r.ingredients).filter((g) => g.legacy?.packOverridden);
  assert.equal(kept.length, src.length);
  assert.deepEqual(kept[0].legacy.packOverridden, src[0].packOverridden);
  assert.equal(kept[0].packOverridden, undefined);
});

test("pack marks collapse into one packMarks object", () => {
  for (const [i, r] of out.entries()) {
    assert.deepEqual(r.packMarks.testing, rows[i].packTestingMarks || []);
    assert.deepEqual(r.packMarks.certification, rows[i].packCertificationMarks || []);
    assert.deepEqual(r.packMarks.diet, rows[i].packDietMarks || []);
    assert.equal(r.packTestingMarks, undefined);
  }
});

test("Amazon-only signals survive, and Shopify's amazonOffer goes under legacy", () => {
  const amz = out.find((r) => r.source === "amazon");
  const srcAmz = rows.find((r) => r.key === amz.key);
  assert.equal(amz.rating, srcAmz.rating);
  assert.equal(amz.asin, srcAmz.asin);
  assert.equal(amz.ingredientsDeclared, srcAmz.ingredientsDeclared ?? null);
  for (const r of out) {
    assert.ok("importedFrom" in r.legacy);
    assert.equal(r.amazonOffer, undefined);
  }
});

test("a bar keeps isFoodForm", () => {
  const bar = out.find((r) => r.isFoodForm);
  assert.ok(bar, "the fixture must contain a bar");
  assert.equal(bar.formFactor, "bar");
});

test("the converted row has no leftover legacy field names at its top level", () => {
  const banned = ["packTestingMarks", "packCertificationMarks", "packDietMarks", "illegibleBadges", "sources", "offers", "factsSource", "factsSourceUrl", "factsLabelImages", "amazonOffer"];
  for (const r of out) for (const k of banned) assert.equal(k in r, false, `${k} should live under legacy`);
});
