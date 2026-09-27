#!/usr/bin/env node
// Pull testing and certification claims out of the listing text we already have.
// These are CLAIMS made by the seller, not verified facts: the field records what the
// listing says, and where it said it, so the assistant can quote it as a claim.
// Out: scripts/e2e/out/products/bulk/certs_patch.json  and  amazon/certs_patch.json
const fs = require("fs"), path = require("path");
const OUT = path.join(__dirname, "../../e2e/out/products");

// Each entry: canonical name, pattern. Ordered so the specific ones win before the generic.
const CLAIMS = [
  ["fssai_licence", /\bfssai\s*(?:lic(?:ence|ense)?\s*(?:no\.?|number)?\s*[:#]?\s*)?(\d{11,14})\b/i],
  ["fssai", /\bfssai\b/i],
  ["informed_sport", /\binformed[- ]sport\b/i],
  ["informed_choice", /\binformed[- ]choice\b/i],
  ["nsf_certified", /\bnsf\b(?!\s*=)/i],
  ["labdoor", /\blabdoor\b/i],
  ["banned_substance_tested", /\b(?:banned[- ]substance|dope|doping)[- ]?(?:free|tested|safe)\b|\bwada\b|\bnada\b/i],
  ["third_party_tested", /\b(?:third|3rd)[- ]party\s*(?:lab\s*)?(?:tested|testing|verified|certified)\b/i],
  ["lab_tested", /\b(?:lab|laboratory|clinically)\s*(?:tested|verified)\b/i],
  ["heavy_metal_tested", /\bheavy[- ]metals?\b[^.]{0,40}\b(?:tested|free|screened|safe)\b|\btested\b[^.]{0,30}\bheavy[- ]metals?\b/i],
  ["certificate_of_analysis", /\b(?:certificate of analysis|coa)\b/i],
  ["gmp", /\bgmp\b|\bgood manufacturing practice/i],
  ["haccp", /\bhaccp\b/i],
  ["iso_certified", /\biso[\s-]?(?:9001|22000|\d{4,5})\b/i],
  ["us_fda_registered", /\b(?:us\s*)?fda[- ](?:registered|approved|compliant)\b/i],
  ["ayush", /\bayush\b/i],
  ["usda_organic", /\busda\s*organic\b/i],
  ["india_organic", /\bindia\s*organic\b|\bjaivik bharat\b/i],
  ["non_gmo", /\bnon[- ]?gmo\b/i],
  ["gluten_free", /\bgluten[- ]free\b/i],
  ["vegan", /\bvegan\b/i],
  ["vegetarian", /\b(?:100%\s*)?veg(?:etarian)?\b(?!\s*capsule)/i],
  ["sugar_free", /\b(?:sugar[- ]free|no added sugar|zero sugar)\b/i],
  ["no_artificial", /\bno artificial (?:colou?rs?|flavou?rs?|sweeteners?|preservatives?)\b/i],
  ["made_in_india", /\bmade in india\b/i],
];

const scan = (text) => {
  const t = String(text || "");
  const found = [];
  let licence = null;
  for (const [name, re] of CLAIMS) {
    const m = t.match(re);
    if (!m) continue;
    if (name === "fssai_licence") { licence = m[1]; found.push("fssai"); continue; }
    if (name === "fssai" && licence) continue;
    found.push(name);
  }
  return { claims: [...new Set(found)], fssaiLicence: licence };
};

// --- Shopify side: the full body html, not the truncated description
const shopIn = JSON.parse(fs.readFileSync(path.join(OUT, "bulk/input.json")));
const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");
const shopPatch = {};
for (const r of shopIn) {
  const res = scan(`${r.title} ${strip(r.bodyHtml)} ${(r.tags || []).join(" ")}`);
  if (res.claims.length || res.fssaiLicence) shopPatch[`${r.store}__${r.id}`] = res;
}
fs.writeFileSync(path.join(OUT, "bulk/certs_patch.json"), JSON.stringify(shopPatch, null, 1));

// --- Amazon side: A+ description, bullet features, the declaration and safety text
const amzPath = path.join(OUT, "amazon/prepared.json");
const amzPatch = {};
if (fs.existsSync(amzPath)) {
  for (const r of JSON.parse(fs.readFileSync(amzPath))) {
    const res = scan([r.title, r.description, r.ingredientsText, r.safetyInfo, ...(r.features || [])].filter(Boolean).join(" "));
    if (res.claims.length || res.fssaiLicence) amzPatch[r.asin] = res;
  }
  fs.writeFileSync(path.join(OUT, "amazon/certs_patch.json"), JSON.stringify(amzPatch, null, 1));
}

const tally = {};
for (const v of [...Object.values(shopPatch), ...Object.values(amzPatch)]) for (const c of v.claims) tally[c] = (tally[c] || 0) + 1;
console.log(`shopify ${Object.keys(shopPatch).length} products with claims | amazon ${Object.keys(amzPatch).length}`);
console.log(`fssai licence numbers found: ${[...Object.values(shopPatch), ...Object.values(amzPatch)].filter((v) => v.fssaiLicence).length}`);
console.log(Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k.padEnd(26)}${n}`).join("\n"));
