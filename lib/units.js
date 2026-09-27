// The one unit table. Legacy kept three numerically-independent copies (merge.js doseKey,
// certs.js F, adjudicate.js F) that had to stay consistent by hand.
const FACTORS = {
  g: 1000, gm: 1000, gms: 1000, gram: 1000, grams: 1000,
  mg: 1,
  mcg: 0.001, "µg": 0.001, ug: 0.001,
  cfu: 1, "billion cfu": 1e9, "million cfu": 1e6,
};

export const normUnit = (u) => (u == null ? null : String(u).trim().toLowerCase());

// Amount in a comparable base (mg for masses, raw counts for CFU). null when the unit is not
// convertible: "%" stays a percentage, "IU" and enzyme units have no mass equivalent.
export function toBase(amount, unit) {
  if (amount == null || unit == null) return null;
  const f = FACTORS[normUnit(unit)];
  return f == null ? null : amount * f;
}

// Two readings of the same line. Identical number+unit counts; otherwise compare in base
// units within a relative tolerance (adjudicate.js's ±2%).
export function sameAmount(a, b, tolerance = 0.02) {
  if (!a || !b) return false;
  if (a[0] === b[0] && normUnit(a[1]) === normUnit(b[1])) return true;
  const x = toBase(a[0], a[1]);
  const y = toBase(b[0], b[1]);
  return x != null && y != null && Math.abs(x - y) <= tolerance * Math.max(Math.abs(x), Math.abs(y), 1e-9);
}

// Units whose amounts are legitimately in the millions or billions, so an "absurd amount"
// rule must not fire on them (125,000 FCCPU of bromelain is a normal label).
export const isBigUnit = (unit, bigUnits) => bigUnits.includes(normUnit(unit) ?? "");

// A per-100g unit on what should be a per-serving row ("g/100g protein", "g per 30 g").
export const isPer100Unit = (unit) => /\bper\s*\d|\/\s*\d+\s*(g|ml|gm)|\b\d+\s*g\b/i.test(String(unit ?? ""));
