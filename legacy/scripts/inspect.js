#!/usr/bin/env node
// Inspect fetched Shopify catalogs: how many rows are supplements, and of those,
// how many carry a per-serving dose in text (title/body) vs need the label image.
// Usage: node scripts/supplements/products/inspect.js [--list <store>]
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "../../e2e/out/products/shopify");

const NON_SUPP = /\b(shaker|bottle|t-?shirt|shorts|joggers|leggings|gloves|belt|band|dumbbell|yoga|mat|towel|bag|cap\b|socks|wrist|knee|rope|roller|mug|frother|blender|pad|tampon|razor|wax|cup\b|panty|liner|wipes|cleanser|face wash|shampoo|serum|cream|lotion|oil\b.*(hair|face|skin|body)|sunscreen|lip|perfume|deodorant|soap|scrub|mask|gift card|e-?gift)\b/i;
const DOSE = /\b\d+(\.\d+)?\s?(mg|mcg|µg|ug|iu|g|gm|gms|grams?|billion|cfu|kcal|%\s?(rda|dv))\b/i;
const INGWORD = /ingredient|each serving|per serving|per scoop|per capsule|per tablet|composition|nutritional (info|facts|value)|supplement facts/i;
const BUNDLE = /\b(combo|bundle|kit|pack of [2-9]|duo|trio|set of)\b/i;

const strip = (h) => (h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const list = process.argv.includes("--list") ? process.argv[process.argv.indexOf("--list") + 1] : null;

const totals = { rows: 0, supp: 0, bundle: 0, dose: 0, ingWord: 0, image: 0, noImg: 0 };
const per = [];
for (const f of fs.readdirSync(DIR).filter((f) => f !== "manifest.json")) {
  const rows = JSON.parse(fs.readFileSync(path.join(DIR, f)));
  const s = { store: f.replace(".json", ""), rows: rows.length, supp: 0, bundle: 0, dose: 0, ingWord: 0, image: 0 };
  for (const r of rows) {
    totals.rows++;
    if (NON_SUPP.test(r.title) || NON_SUPP.test(r.productType)) continue;
    s.supp++; totals.supp++;
    if (BUNDLE.test(r.title)) { s.bundle++; totals.bundle++; }
    const text = r.title + " " + strip(r.bodyHtml);
    let cls;
    if (DOSE.test(text)) cls = "dose";
    else if (INGWORD.test(text)) cls = "ingWord";
    else cls = r.images.length ? "image" : "noImg";
    s[cls] = (s[cls] || 0) + 1; totals[cls]++;
    if (list === s.store) console.log(cls.padEnd(8), r.title.slice(0, 90));
  }
  per.push(s);
}
if (list) process.exit(0);
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "-");
console.log("store".padEnd(26), "rows supp bund | dose ingW img none | text%");
for (const s of per.sort((a, b) => b.supp - a.supp))
  console.log(s.store.padEnd(26), String(s.rows).padStart(4), String(s.supp).padStart(4), String(s.bundle).padStart(4), "|",
    String(s.dose).padStart(4), String(s.ingWord || 0).padStart(4), String(s.image || 0).padStart(4), String(s.noImg || 0).padStart(4), "|", pct(s.dose + (s.ingWord || 0), s.supp).padStart(4));
console.log("\nTOTAL", totals, "\ntext-or-ingword share of supplements:", pct(totals.dose + totals.ingWord, totals.supp), "| with any image:", pct(totals.supp - totals.noImg, totals.supp));
