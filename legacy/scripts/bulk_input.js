#!/usr/bin/env node
// Build the extraction input list from every fetched Shopify catalog.
// Drops obvious non-supplements (same regex as inspect.js) and rows with no photo,
// since the extractor reads the label off the images.
// Out: scripts/e2e/out/products/bulk/input.json
// Usage: node scripts/supplements/products/bulk_input.js
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "../../e2e/out/products/shopify");
const OUT = path.join(__dirname, "../../e2e/out/products/bulk");

const NON_SUPP = /\b(shaker|bottle|t-?shirt|shorts|joggers|leggings|gloves|belt|band|dumbbell|yoga|mat|towel|bag|cap\b|socks|wrist|knee|rope|roller|mug|frother|blender|pad|tampon|razor|wax|cup\b|panty|liner|wipes|cleanser|face wash|shampoo|serum|cream|lotion|oil\b.*(hair|face|skin|body)|sunscreen|lip|perfume|deodorant|soap|scrub|mask|gift card|e-?gift)\b/i;

fs.mkdirSync(OUT, { recursive: true });
const rows = [];
const dropped = { nonSupp: 0, noImage: 0 };
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json")) {
  const store = f.replace(/\.json$/, "");
  for (const r of JSON.parse(fs.readFileSync(path.join(DIR, f)))) {
    if (NON_SUPP.test(r.title || "") || NON_SUPP.test(r.productType || "")) { dropped.nonSupp++; continue; }
    if (!r.images || !r.images.length) { dropped.noImage++; continue; }
    rows.push({ ...r, store });
  }
}
fs.writeFileSync(path.join(OUT, "input.json"), JSON.stringify(rows, null, 1));
console.log(`${rows.length} rows -> ${path.join(OUT, "input.json")}  dropped ${JSON.stringify(dropped)}`);
