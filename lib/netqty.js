// splitNetQty: the field took four iterations against real labels ("Pack of 60's",
// "60N Tablets", "Net Wt: 250g", "5 x 33.8g = 169g") and the model sometimes answers with its
// reasoning attached. The measured value stays in netQuantity, the caveat moves to a note.
import { NET_QTY_UNITS as UNIT } from "../config/rules.js";

// Optional "pack of", an optional "5 x " multiplier, a number, up to two descriptor words
// ("Veg", "chewable"), then the unit. Anything after that is commentary.
const NQ = new RegExp(
  "^\\s*\\(?\\s*(?:pack\\s+of\\s+)?" +
    "(?:\\d+(?:[.,]\\d+)?\\s*(?:x|×)\\s*)?" +
    "\\d+(?:[.,]\\d+)?(?:'s)?" +
    "(?:\\s*(?:x|×)\\s*\\d+(?:[.,]\\d+)?)?" +
    "\\s*(?:[a-z]{2,12}\\.?\\s+){0,2}" +
    "(?:" + UNIT + ")?\\b\\.?",
  "i",
);
// A trailing total such as ") = 169 g" belongs to the value, not the commentary.
const NQ_TOTAL = new RegExp("^\\s*\\)?\\s*=\\s*\\d+(?:[.,]\\d+)?\\s*(?:" + UNIT + ")\\b", "i");
// "60N Tablets" splits into value "60N" and remainder "Tablets": a bare unit word belongs to
// the value, not to a caveat note.
const BARE_UNIT = /^(?:veg\.?\s*)?(?:tablets?|capsules?|softgels?|sachets?|sticks?|gummies|servings?|scoops?|shots?|ml|g|gm|grams?|kg)\.?$/i;

/** @returns {[string|null, string|null]} [netQuantity, netQuantityNote] */
export function splitNetQty(raw) {
  if (!raw) return [null, null];
  const v = String(raw).trim();
  // Strip a leading "Net wt", "Net weight", "For" before matching.
  const lead = v.replace(/^\s*(?:net\s*(?:wt\.?|weight)|total\s*qty|box\s*of|bottle\s*of|jar\s*of|for)\s*[:\-]?\s*/i, "");
  const m = lead.match(NQ);
  if (!m) return [null, v];
  let take = m[0].length;
  const t = lead.slice(take).match(NQ_TOTAL);
  if (t) take += t[0].length;
  const value = lead.slice(0, take).replace(/^[\s(]+/, "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
  const rest = lead.slice(take).replace(/^[\s;,.()=-]+/, "").replace(/[()]/g, "").trim();
  if (BARE_UNIT.test(rest)) return [(value + " " + rest).trim(), null];
  return [value || null, rest || null];
}
