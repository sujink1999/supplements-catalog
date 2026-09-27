#!/usr/bin/env node
// Three independent reads of the same label: extracted/ (read 1), recheck/ (read 2),
// effort_high/ (read 3, high reasoning, only for products where 1 and 2 disagreed).
// Majority wins. No majority = we do not know the dose, so the amount is nulled and the
// row is marked unverified rather than stating a number we cannot stand behind.
// Out: scripts/e2e/out/products/bulk/adjudicated.json  (key -> { rows, stats })
const fs = require("fs"), path = require("path");
const D = path.join(__dirname, "../../e2e/out/products/bulk");
// Read 2 was run twice: recheck/ covered a first slice, read2/ then covered the whole
// catalogue. Either one counts as the second read; read2/ wins where both exist.
// read3/ is not just another vote: it was the first read told that a photographed pack
// outranks a flat spec graphic, and brands ship packs whose numbers differ from the graphic
// they publish. Where it read a line, its value stands; the older reads only corroborate it.
const dirs = { r0: path.join(D, "read3"), r1: path.join(D, "extracted"), r2: path.join(D, "read2"), r2b: path.join(D, "recheck"), r3: path.join(D, "effort_high") };

const F = { g: 1000, gm: 1000, mg: 1, mcg: 0.001, "µg": 0.001, ug: 0.001, cfu: 1, "billion cfu": 1e9 };
const base = (a, u) => (a == null || u == null ? null : F[String(u).trim().toLowerCase()] == null ? null : a * F[String(u).trim().toLowerCase()]);
const same = (x, y) => {
  if (!x || !y) return false;
  if (x[0] === y[0] && String(x[1]).toLowerCase() === String(y[1]).toLowerCase()) return true;
  const a = base(...x), b = base(...y);
  return a != null && b != null && Math.abs(a - b) <= 0.02 * Math.max(Math.abs(a), Math.abs(b), 1e-9);
};
const read = (dir, key) => {
  const p = path.join(dir, key + ".json");
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p));
  if (!d.facts) return null;
  const m = new Map();
  for (const r of d.facts.rows) m.set(r.printedName.trim().toLowerCase(), r);
  return m;
};

const out = {};
const stats = { products: 0, agreed: 0, packWins: 0, majority: 0, singleRead: 0, unresolved: 0 };
const secondRead = new Set([...fs.readdirSync(dirs.r0), ...fs.readdirSync(dirs.r2), ...fs.readdirSync(dirs.r2b)].filter((f) => f.endsWith(".json")));
for (const f of secondRead) {
  const key = f.replace(".json", "");
  const m0 = read(dirs.r0, key);
  const m1 = read(dirs.r1, key), m2 = read(dirs.r2, key) || read(dirs.r2b, key), m3 = read(dirs.r3, key);
  if (!m0 && (!m1 || !m2)) continue;
  if (m0 && !m1) { stats.products++; out[key] = [...m0.values()].map((r) => ({ ...r, agreement: "1/1" })); stats.singleRead += m0.size; continue; }
  stats.products++;
  const rows = [];
  for (const [name, r1] of (m0 || m1)) {
    // r1 is whichever read owns the spine; when read3 owns it the others are corroboration.
    const r0 = m0 && m0.get(name), r2 = m2 && m2.get(name), r3 = m3 && m3.get(name);
    if (r0) {
      const o1 = m1 && m1.get(name), v0 = [r0.amount, r0.unit];
      const backed = [o1, r2, r3].some((r) => r && same(v0, [r.amount, r.unit]));
      if (backed) { stats.agreed++; rows.push({ ...r0, agreement: "2/2" }); continue; }
      const others = [o1, r2, r3].filter(Boolean).map((r) => `${r.amount} ${r.unit}`);
      if (!others.length) { stats.singleRead++; rows.push({ ...r0, agreement: "1/1" }); continue; }
      stats.packWins++;
      rows.push({ ...r0, agreement: "pack", packOverridden: others });
      continue;
    }
    const v1 = [r1.amount, r1.unit], v2 = r2 && [r2.amount, r2.unit], v3 = r3 && [r3.amount, r3.unit];
    // Row absent from the other read is a naming difference, not a dose dispute: keep it as a single read.
    if (!r2) { stats.singleRead++; rows.push({ ...r1, agreement: "1/1" }); continue; }
    if (same(v1, v2)) { stats.agreed++; rows.push({ ...r1, agreement: "2/2" }); continue; }
    if (v3 && same(v3, v1)) { stats.majority++; rows.push({ ...r1, agreement: "2/3" }); continue; }
    if (v3 && same(v3, v2)) { stats.majority++; rows.push({ ...r2, agreement: "2/3" }); continue; }
    // No two reads agree: keep the ingredient, drop the number.
    stats.unresolved++;
    rows.push({ ...r1, amount: null, agreement: "none", amountUnverified: true,
      candidates: [v1, v2, v3].filter(Boolean).map(([a, u]) => `${a} ${u}`) });
  }
  out[key] = rows;
}
fs.writeFileSync(path.join(D, "adjudicated.json"), JSON.stringify(out, null, 1));
console.log(`${stats.products} re-read products | rows: ${stats.agreed} agreed 2/2, ${stats.majority} settled 2/3, ${stats.packWins} taken from the pack over a conflicting graphic, ${stats.singleRead} seen by one read only, ${stats.unresolved} unresolved (amount nulled)`);
