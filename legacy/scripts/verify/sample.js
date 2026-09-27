#!/usr/bin/env node
// Stratified sample of fetched Shopify products for the verify pass.
// 15 text-dose · 10 ingredient-words · 15 image-only · 5 suspected bundles, spread across stores.
// Output: scripts/e2e/out/products/verify/sample.json
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "../../../e2e/out/products/shopify");
const OUT = path.join(__dirname, "../../../e2e/out/products/verify");
const NON_SUPP = /\b(shaker|bottle|t-?shirt|shorts|joggers|leggings|gloves|belt|band|dumbbell|yoga|mat|towel|bag|cap\b|socks|wrist|knee|rope|roller|mug|frother|blender|pad|tampon|razor|wax|cup\b|panty|liner|wipes|cleanser|face wash|shampoo|serum|cream|lotion|sunscreen|lip|perfume|deodorant|soap|scrub|mask|gift card|e-?gift)\b/i;
const DOSE = /\b\d+(\.\d+)?\s?(mg|mcg|µg|ug|iu|g|gm|gms|grams?|billion|cfu)\b/i;
const INGWORD = /ingredient|each serving|per serving|per scoop|per capsule|per tablet|composition|nutritional (info|facts|value)|supplement facts/i;
const BUNDLE = /\b(combo|bundle|kit|pack of [2-9]|duo|trio|set of)\b/i;
const strip = (h) => (h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const QUOTA = { dose: 15, ingWord: 10, image: 15, bundle: 5 };
const buckets = { dose: [], ingWord: [], image: [], bundle: [] };
for (const f of fs.readdirSync(DIR).filter((f) => f !== "manifest.json" && f !== "boldfit.com.json")) {
  for (const r of JSON.parse(fs.readFileSync(path.join(DIR, f)))) {
    if (NON_SUPP.test(r.title) || NON_SUPP.test(r.productType) || !r.images.length) continue;
    const text = r.title + " " + strip(r.bodyHtml);
    const cls = BUNDLE.test(r.title) ? "bundle" : DOSE.test(text) ? "dose" : INGWORD.test(text) ? "ingWord" : "image";
    buckets[cls].push({ ...r, sampleClass: cls });
  }
}
// deterministic spread: sort by store then take every k-th
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const picked = [];
for (const [cls, n] of Object.entries(QUOTA)) {
  const pool = buckets[cls].sort(() => rnd() - 0.5);
  const perStore = {};
  for (const r of pool) {
    if (picked.filter((p) => p.sampleClass === cls).length >= n) break;
    if ((perStore[r.store] || 0) >= 2) continue;
    perStore[r.store] = (perStore[r.store] || 0) + 1;
    picked.push(r);
  }
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "sample.json"), JSON.stringify(picked, null, 1));
for (const p of picked) console.log(p.sampleClass.padEnd(8), p.store.padEnd(24), p.title.slice(0, 80));
console.log("\n" + picked.length, "sampled →", path.join(OUT, "sample.json"));
