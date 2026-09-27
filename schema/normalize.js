// Pure unit normalisation. No I/O, no env, no DB. Imported by stages/import.js.
//
// Two separate jobs, deliberately not fused:
//   normalizeUnit(raw) -> unit_norm     a canonical spelling of whatever was printed
//   toMg({amount, unit}) -> amount_mg   ONLY for mass units (g/mg/mcg); null otherwise
//
// The printed `amount` and `unit` are stored verbatim alongside these. Percentages,
// CFU, IU, kcal and "g/100 g protein"-style ratios are NOT masses and never get an
// amount_mg: an IU->mg factor is vitamin-specific and guessing one silently corrupts
// a dose filter.

// raw (lowercased, punctuation-stripped where noted) -> unit_norm
const UNIT_MAP = new Map(Object.entries({
  // energy
  "kcal": "kcal", "kilocalories": "kcal", "kilocalorie": "kcal", "cal": "kcal",
  "calories": "kcal", "calorie": "kcal", "energy (kcal)": "kcal",
  "kj": "kj", "kilojoules": "kj",
  // mass
  "g": "g", "gm": "g", "gms": "g", "gram": "g", "grams": "g",
  "mg": "mg", "milligram": "mg", "milligrams": "mg",
  "mcg": "mcg", "ug": "mcg", "µg": "mcg", "μg": "mcg",
  "microgram": "mcg", "micrograms": "mcg",
  // Equivalence units: a mass with a potency basis attached. NOT plain masses --
  // "mcg RAE" of beta-carotene is not "mcg" of retinol, so they get no amount_mg.
  "mcg dfe": "mcg_dfe", "mcg rae": "mcg_rae", "mcg re": "mcg_re",
  "mg ne": "mg_ne", "mg te": "mg_te", "mg α-te": "mg_te", "mg a-te": "mg_te",
  "mg alpha-te": "mg_te",
  "kg": "kg",
  // volume
  "ml": "ml", "millilitre": "ml", "milliliter": "ml", "l": "l", "litre": "l", "liter": "l",
  // activity / count units
  "iu": "IU", "i.u.": "IU", "i u": "IU", "iu.": "IU",
  "cfu": "cfu",
  "billion cfu": "bn_cfu", "bn cfu": "bn_cfu", "billion cfus": "bn_cfu",
  "million cfu": "mn_cfu", "mn cfu": "mn_cfu", "million cfus": "mn_cfu",
  "billion cfu/g": "bn_cfu_per_g", "billion cfu per g": "bn_cfu_per_g",
  "hut": "hut", "fcc hut": "hut", "spu": "spu", "gdu": "gdu", "alu": "alu",
  "sapu": "sapu", "fip": "fip", "usp": "usp",
  // proportion
  "%": "pct", "% w/w": "pct_ww", "% w/v": "pct_wv", "percent": "pct",
  // quantum satis ("as much as needed") -- a real printed value with no amount
  "q.s.": "qs", "q.s": "qs", "qs": "qs", "q s": "qs", "quantum satis": "qs",
  // spore-count probiotics
  "billion spores": "bn_spores", "million spores": "mn_spores",
  "billion cells": "bn_cells", "million cells": "mn_cells",
  // countable
  "capsule": "capsule", "capsules": "capsule", "tablet": "tablet", "tablets": "tablet",
  "serving": "serving", "servings": "serving", "drop": "drop", "drops": "drop",
}));

// Units that are a mass and therefore convertible to mg.
const MASS_TO_MG = { kg: 1e6, g: 1000, mg: 1, mcg: 0.001 };

/** Lowercase, collapse whitespace, strip a wrapping paren/bracket. Keeps '.', '%', '/'. */
function cleanUnitString(raw) {
  if (raw == null) return "";
  return String(raw)
    .replace(/ /g, " ")
    .trim()
    .replace(/^[(\[]\s*/, "")
    .replace(/\s*[)\]]$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Canonical spelling for a printed unit string.
 * Returns null for an absent/blank unit (macro rows legitimately have none).
 * Returns a normalised ratio form for "g/100 g protein" style strings.
 * Returns the cleaned string unchanged when unrecognised (never throws, never
 * invents a mass) -- an unknown unit must still be storable and greppable.
 */
function normalizeUnit(raw) {
  const s = cleanUnitString(raw);
  if (!s) return null;

  if (UNIT_MAP.has(s)) return UNIT_MAP.get(s);

  // "g per 100 g protein" -> "g/100 g protein"; then collapse spaces around '/'.
  const perForm = s.replace(/\s+per\s+/g, "/");
  if (UNIT_MAP.has(perForm)) return UNIT_MAP.get(perForm);

  // Ratio units: "<unit>/<qty><unit>[ <basis>]" -> "<unit>_per_<qty><unit>[_<basis>]"
  const ratio = perForm.match(/^([a-zµμ%]+)\s*\/\s*(\d+)\s*([a-zµμ]+)\s*(.*)$/);
  if (ratio) {
    const num = UNIT_MAP.get(ratio[1]) || ratio[1];
    const den = UNIT_MAP.get(ratio[3]) || ratio[3];
    const basis = ratio[4].trim().replace(/\s+/g, "_");
    return `${num}_per_${ratio[2]}${den}` + (basis ? `_${basis}` : "");
  }

  // "% per 100g" -> pct_per_100g
  const pctPer = perForm.match(/^%\s*\/\s*(\d+)\s*([a-z]+)$/);
  if (pctPer) return `pct_per_${pctPer[1]}${UNIT_MAP.get(pctPer[2]) || pctPer[2]}`;

  return perForm;
}

/** True only for units that are unambiguously a mass. */
function isMassUnit(unitNorm) {
  return Object.prototype.hasOwnProperty.call(MASS_TO_MG, unitNorm);
}

/**
 * amount_mg for an ingredient row, or null.
 * Null whenever the amount is missing/non-finite or the unit is not a mass
 * (%, CFU, IU, kcal, ml, ratios, qs, counts, unknown).
 */
function toMg(amount, rawUnit) {
  if (amount == null || amount === "") return null;
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return null;
  const u = normalizeUnit(rawUnit);
  if (!u || !isMassUnit(u)) return null;
  const mg = n * MASS_TO_MG[u];
  // Keep it representable: round to 6 decimals so 0.001 mcg steps survive.
  return Math.round(mg * 1e6) / 1e6;
}

/** Convenience: {unitNorm, amountMg} for one printed pair. */
function normalizeAmount(amount, rawUnit) {
  return { unitNorm: normalizeUnit(rawUnit), amountMg: toMg(amount, rawUnit) };
}

export {
  normalizeUnit,
  normalizeAmount,
  toMg,
  isMassUnit,
  cleanUnitString,
  MASS_TO_MG,
  UNIT_MAP,
};
