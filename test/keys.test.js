import test from "node:test";
import assert from "node:assert/strict";
import { shopifyKey, amazonKey, keyOf, parseKey, keyToFile } from "../lib/keys.js";

test("one Amazon key format, not the legacy three", () => {
  assert.equal(amazonKey("B00KDFRUGY"), "amazon.in__B00KDFRUGY");
  assert.notEqual(amazonKey("B00KDFRUGY"), "amazon__B00KDFRUGY");
});

test("keyOf picks the format from the row, for both sources", () => {
  assert.equal(keyOf({ source: "shopify", store: "aceblend.com", id: 123 }), "aceblend.com__123");
  assert.equal(keyOf({ source: "amazon", asin: "B01" }), "amazon.in__B01");
  assert.equal(keyOf({ store: "amazon.in", id: "B02" }), "amazon.in__B02");
});

test("parseKey round-trips a store that contains dots", () => {
  assert.deepEqual(parseKey(shopifyKey("in.fastandup.com", 99)), { store: "in.fastandup.com", id: "99", source: "shopify" });
  assert.deepEqual(parseKey("amazon.in__B01"), { store: "amazon.in", id: "B01", source: "amazon" });
  assert.deepEqual(parseKey("nonsense"), { store: null, id: "nonsense", source: null });
});

test("keyToFile cannot escape its directory", () => {
  assert.equal(keyToFile("aceblend.com__7839305269506"), "aceblend.com__7839305269506");
  assert.ok(!keyToFile("../../etc/passwd").includes("/"));
});
