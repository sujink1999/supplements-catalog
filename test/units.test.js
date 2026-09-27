import test from "node:test";
import assert from "node:assert/strict";
import { toBase, sameAmount, normUnit, isBigUnit, isPer100Unit } from "../lib/units.js";
import { THRESHOLDS } from "../config/rules.js";

test("toBase converts masses to mg and leaves unconvertible units null", () => {
  assert.equal(toBase(2, "g"), 2000);
  assert.equal(toBase(600, "mg"), 600);
  assert.equal(toBase(400, "mcg"), 0.4);
  assert.equal(toBase(400, "µg"), 0.4);
  assert.equal(toBase(10, "billion CFU"), 1e10);
  assert.equal(toBase(7, "%"), null, "a percentage has no mass equivalent and must never be converted");
  assert.equal(toBase(200, "IU"), null);
  assert.equal(toBase(null, "mg"), null);
});

test("sameAmount matches across units and within tolerance", () => {
  assert.ok(sameAmount([1, "g"], [1000, "mg"]));
  assert.ok(sameAmount([10, "billion CFU"], [1e10, "CFU"]));
  assert.ok(sameAmount([600, "mg"], [601, "mg"]), "within 2%");
  assert.ok(!sameAmount([600, "mg"], [700, "mg"]));
  assert.ok(sameAmount([7, "%"], [7, "%"]), "identical number and unit needs no conversion");
  assert.ok(!sameAmount([7, "%"], [70, "mg"]));
  assert.ok(!sameAmount(null, [1, "g"]));
});

test("normUnit lowercases and trims the casing variants the data actually contains", () => {
  assert.equal(normUnit(" Kcal "), "kcal");
  assert.equal(normUnit("I.U."), "i.u.");
  assert.equal(normUnit(null), null);
});

test("isBigUnit spares enzyme and colony units from the absurd-amount rule", () => {
  assert.ok(isBigUnit("FCCPU", THRESHOLDS.bigUnits));
  assert.ok(isBigUnit("HUT", THRESHOLDS.bigUnits));
  assert.ok(isBigUnit("CFU", THRESHOLDS.bigUnits));
  assert.ok(!isBigUnit("mg", THRESHOLDS.bigUnits));
});

test("isPer100Unit spots a per-100g unit sitting on a per-serving row", () => {
  assert.ok(isPer100Unit("g/100g protein"));
  assert.ok(isPer100Unit("g per 30 g"));
  assert.ok(isPer100Unit("g per 100 ml"));
  assert.ok(!isPer100Unit("mg"));
  assert.ok(!isPer100Unit("billion CFU"));
});
