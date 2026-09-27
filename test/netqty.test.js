import test from "node:test";
import assert from "node:assert/strict";
import { splitNetQty } from "../lib/netqty.js";

// The strings that took four iterations against real Indian labels (issue 29).
const cases = [
  ["250 g", ["250 g", null]],
  ["Net Wt: 250g", ["250g", null]],
  ["Pack of 60's", ["Pack of 60's", null]],
  ["60N Tablets", ["60N Tablets", null]],
  ["5 x 33.8g = 169g", ["5 x 33.8g = 169g", null]],
  ["60 Veg Capsules", ["60 Veg Capsules", null]],
  ["1 kg", ["1 kg", null]],
  ["30 sachets (listing tiles indicate 10; label photo shows no full pack count)", ["30 sachets", "listing tiles indicate 10; label photo shows no full pack count"]],
];

test("splitNetQty keeps the measured value and moves commentary to a note", () => {
  for (const [input, expected] of cases) {
    assert.deepEqual(splitNetQty(input), expected, `input: ${input}`);
  }
});

test("splitNetQty on nothing, and on text with no measurement at all", () => {
  assert.deepEqual(splitNetQty(null), [null, null]);
  assert.deepEqual(splitNetQty(""), [null, null]);
  assert.deepEqual(splitNetQty("not printed on the pack"), [null, "not printed on the pack"]);
});
