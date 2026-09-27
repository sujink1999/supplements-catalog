import test from "node:test";
import assert from "node:assert/strict";
import { verificationTier, rank, isFoodForm, TIERS } from "../lib/verification.js";

const tier = (o) => verificationTier({ titleOnly: false, hasLabel: true, lowResLabel: false, confidence: 0.9, ...o });

test("the five tiers, in the order the ladder checks them", () => {
  assert.equal(tier({}), "label_read");
  assert.equal(tier({ confidence: 0.69 }), "unverified_low_confidence");
  assert.equal(tier({ lowResLabel: true }), "unverified_low_res");
  assert.equal(tier({ hasLabel: false }), "unverified_no_label");
  assert.equal(tier({ titleOnly: true }), "unverified_title_only");
});

test("0.7 is the cutoff, not 0.7-ish", () => {
  assert.equal(tier({ confidence: 0.7 }), "label_read");
  assert.equal(tier({ confidence: 0.6999 }), "unverified_low_confidence");
});

test("titleOnly beats every other signal, and no-label beats low-res", () => {
  assert.equal(tier({ titleOnly: true, hasLabel: false, lowResLabel: true, confidence: 0.1 }), "unverified_title_only");
  assert.equal(tier({ hasLabel: false, lowResLabel: true }), "unverified_no_label");
});

test("rank orders the ladder for picking the better-evidenced row", () => {
  assert.ok(rank("label_read") > rank("unverified_low_res"));
  assert.ok(rank("unverified_low_res") > rank("unverified_no_label"));
  assert.ok(rank("unverified_no_label") > rank("unverified_title_only"));
  assert.equal(rank("nonsense"), -1);
  assert.equal(Object.keys(TIERS).length, 5);
});

test("isFoodForm is true only for a bar", () => {
  assert.equal(isFoodForm("bar"), true);
  assert.equal(isFoodForm("Bar"), true);
  assert.equal(isFoodForm("capsule"), false);
  assert.equal(isFoodForm(null), false);
});
