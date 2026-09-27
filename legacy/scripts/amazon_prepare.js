#!/usr/bin/env node
// Filter the raw Amazon brand pulls down to what is worth extracting, then build one
// extractor input file. Drops other brands' listings that leaked into a brand search,
// and non-supplements (gear, apparel, food staples) by title, form and breadcrumb.
// Out: scripts/e2e/out/products/amazon/prepared.json (+ amazon/dropped.json)
const fs = require("fs"), path = require("path");
const D = path.join(__dirname, "../../e2e/out/products/amazon");

// A brand's Amazon string differs from ours ("PLIX - THE PLANT FIX"), and one brand can
// use several. Match on any distinctive token rather than the whole string.
const ALIASES = {
  "plix-the-plant-fix": ["plix", "plant fix"],
  "hk-vitals": ["hk vitals", "healthkart"],
  "be-bodywise": ["bodywise"],
  "bhumija-lifesciences": ["bhumija"],
  "nature-s-velvet": ["nature's velvet", "natures velvet", "nature velvet"],
  "the-whole-truth": ["whole truth"],
  "muscleblaze": ["muscleblaze", "muscle blaze"],
  "man-matters": ["man matters"],
  "truebasics": ["truebasics", "true basics"],
  "autoimmunity-care": ["autoimmunity"],
  "be-": ["be wellness", "be."], "be-supplement": ["be wellness", "be."],
  "be-wellness-gummies": ["be wellness", "be."], "be-vitamin": ["be wellness", "be."],
};
// A keyword pull is named after the query ("boldfit-whey-protein"), so derive the brand
// from its first token rather than the whole filename.
const aliasesFor = (file) => ALIASES[file] || (file.startsWith("boldfit-") ? ["boldfit"] : [file.replace(/-/g, " ")]);

const GEAR = /\b(resistance band|tube band|loop band|skipping rope|jump rope|yoga mat|dumbbell|kettlebell|barbell|weight plate|gym bag|shaker|sipper|bottle|gloves|wrist|knee cap|ankle|support belt|foam roller|massager|gun\b|tape|grip|push[- ]?up|ab roller|hula|treadmill|cycle\b|t-?shirt|shorts|joggers|track ?pant|stringer|vest|socks|cap\b|towel|scale\b|band set)\b/i;
const FOOD = /\b(muesli|oats|peanut butter|granola|atta|flour|ghee|honey|spread|chocolate bar|snack bar|cookies|biscuit|namkeen|masala|pickle|rice\b|dal\b|tea bags?)\b/i;
const TOPICAL = /\b(shampoo|conditioner|face wash|facewash|serum|cream|lotion|moisturis|sunscreen|body wash|soap|scrub|mask\b|hair oil|beard|deodorant|perfume|roll[- ]?on|gel\b|toothpaste|wipes|razor|trimmer|lip balm|kajal|foundation|nail)\b/i;
const NON_FORM = /^(?:band|mat|bottle|apparel|cream|serum|lotion|gel|spray|shampoo|soap|oil)$/i;

const prepared = [], dropped = [];
const perBrand = {};
for (const f of fs.readdirSync(D).filter((f) => f.endsWith(".json") && !f.startsWith("_") && !/^(prepared|dropped|extract_input|extract_new|fill_input|fill_input_raw|clean|rejects|recheck_input|_test_input|img_manifest|catalog|merge_report)\.json$/.test(f))) {
  const file = f.replace(/\.json$/, "");
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(D, f))); } catch { continue; }
  if (!Array.isArray(rows) || !rows.length) continue;
  const al = aliasesFor(file);
  const stat = { total: rows.length, offBrand: 0, gear: 0, food: 0, topical: 0, noImage: 0, kept: 0 };
  const seen = new Set();
  for (const r of rows) {
    const hay = `${r.brand || ""} ${r.title || ""}`.toLowerCase();
    const why = !al.some((a) => hay.includes(a)) ? "off_brand"
      : TOPICAL.test(r.title || "") ? "topical"
      : GEAR.test(r.title || "") || NON_FORM.test(r.itemForm || "") ? "gear"
      : FOOD.test(r.title || "") ? "food"
      : !(r.images || []).length ? "no_image"
      : r.asin && seen.has(r.asin) ? "duplicate" : null;
    if (why) {
      if (why === "off_brand") stat.offBrand++;
      else if (why === "gear") stat.gear++;
      else if (why === "food") stat.food++;
      else if (why === "topical") stat.topical++;
      else if (why === "no_image") stat.noImage++;
      dropped.push({ brand: file, asin: r.asin, title: r.title, reason: why });
      continue;
    }
    seen.add(r.asin);
    stat.kept++;
    prepared.push({ ...r, brandFile: file });
  }
  perBrand[file] = stat;
}

fs.writeFileSync(path.join(D, "prepared.json"), JSON.stringify(prepared, null, 1));
fs.writeFileSync(path.join(D, "dropped.json"), JSON.stringify(dropped, null, 1));

// Extractor input: Amazon's own 1500px photos, its A+ copy as the description.
const input = prepared.map((r) => ({
  store: "amazon.in", id: r.asin, url: r.url, title: r.title,
  vendor: r.brand || r.brandFile, productType: r.supplementType || "", tags: [],
  bodyHtml: [r.description, r.ingredientsText, r.doseDirections, ...(r.features || [])].filter(Boolean).join(" — "),
  variants: [{ title: r.unitCount || "default", price: r.price }],
  images: (r.images || []).slice(0, 12).map((u) => ({ src: u, w: 1500, h: 1500 })),
}));
fs.writeFileSync(path.join(D, "extract_input.json"), JSON.stringify(input, null, 1));

console.log(`${prepared.length} kept for extraction, ${dropped.length} dropped\n`);
console.log("brand".padEnd(22) + "total  kept  offBrand  gear  food  topical");
for (const [b, s] of Object.entries(perBrand).sort((a, c) => c[1].total - a[1].total))
  console.log(b.padEnd(22) + String(s.total).padStart(5) + String(s.kept).padStart(6) + String(s.offBrand).padStart(10) + String(s.gear).padStart(6) + String(s.food).padStart(6) + String(s.topical).padStart(9));
