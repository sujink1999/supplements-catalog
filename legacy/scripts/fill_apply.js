#!/usr/bin/env node
// Apply the Amazon re-reads to Shopify products whose own photos had no usable label.
// The Shopify listing stays the product of record (its URL, its variants, its price);
// only the facts come from Amazon, and the record says so.
// Out: rewrites bulk/clean.json in place via a patch file the cleaner reads.
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "../../e2e/out/products");
const FX = path.join(OUT, "amazon/fill_extracted");
const patch = {};
const stat = { read: 0, stillNoLabel: 0, notSupplement: 0, worse: 0 };

for (const f of fs.readdirSync(FX).filter((f) => f.endsWith(".json"))) {
  const x = JSON.parse(fs.readFileSync(path.join(FX, f)));
  // id is "<shopifyStore>__<shopifyId>__<ASIN>"; recover the Shopify key.
  const parts = String(x.id).split("__");
  const key = parts.slice(0, 2).join("__");
  const fa = x.facts;
  if (x.classify.listing !== "supplement") { stat.notSupplement++; continue; }
  if (!fa) { stat.stillNoLabel++; continue; }
  const acts = fa.rows.filter((r) => r.role === "active" && r.amount != null);
  if (!x.labelImages.length || !acts.length) { stat.stillNoLabel++; continue; }
  stat.read++;
  patch[key] = {
    ingredients: fa.rows,
    servingSize: fa.servingSize, servingsPerContainer: fa.servingsPerContainer,
    netQuantity: fa.netQuantity, doseDirections: fa.doseDirections, formFactor: fa.formFactor,
    confidence: fa.confidence, notes: fa.notes,
    verification: fa.lowResLabel ? "unverified_low_res" : fa.confidence < 0.7 ? "unverified_low_confidence" : "label_read",
    factsSource: "amazon", factsSourceUrl: x.url, factsLabelImages: x.labelImages,
    factsModel: x.model,
  };
}
fs.writeFileSync(path.join(OUT, "bulk/fill_patch.json"), JSON.stringify(patch, null, 1));
console.log(`${Object.keys(patch).length} Shopify products get their facts from Amazon`, stat);
