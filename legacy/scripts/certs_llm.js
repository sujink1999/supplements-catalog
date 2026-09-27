#!/usr/bin/env node
// Turn the regex's candidate claims into judged ones. The regex cannot tell a product's own
// certification from an ingredient's, "tested for heavy metals" from "free from heavy metals",
// or the Informed Choice programme from the words "evidence-informed choice". This asks a model,
// one product per call with a short excerpt, so the job stays small and the system prompt caches.
// Usage: node certs_llm.js [--limit N] [--conc 8] [--force]
// Out: scripts/e2e/out/products/bulk/certs_judged/<key>.json
const fs = require("fs"), path = require("path"), OpenAI = require("openai");
{ const fs0 = require("fs");
  for (const root of [path.join(__dirname, "../../.."), path.join(__dirname, "../../../../../..")]) {
    if (fs0.existsSync(path.join(root, ".env"))) { require("dotenv").config({ path: path.join(root, ".env"), quiet: true }); require("dotenv").config({ path: path.join(root, ".env.local"), override: true, quiet: true }); break; } } }
const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MODEL = flag("--model", "gpt-6-luna"), LIMIT = Number(flag("--limit", 0)), CONC = Number(flag("--conc", 8));
const FORCE = args.includes("--force");
const OUT = path.join(__dirname, "../../e2e/out/products");
const JUDGED = path.join(OUT, "bulk/certs_judged");

const SYS = `You decide which quality certifications and tests a supplement listing claims FOR THE FINISHED PRODUCT.
Rules:
- Only the product itself counts. A certification held by one raw ingredient or by the manufacturing site's supplier ("KSM-66 has USP and NSF certifications") is ingredientLevel, not the product's.
- "Tested for X" is testing. "Free from X" or "no X" is a purity claim, not testing. Keep them apart.
- Named third-party programmes only where actually named: Informed Sport, Informed Choice, NSF Certified for Sport, Labdoor, USP Verified, Eurofins, NABL, WADA batch testing. The ordinary English words "informed choice" are not the programme.
- Ignore generic marketing ("highest quality", "trusted by athletes") and ignore background explanation of what an agency does.
- A licence or registration is not a quality test: FSSAI, AYUSH, ISO and GMP describe the factory or the legal listing. Record them, but as facility/licence, never as product testing.
- NABL is India's lab accreditation body. "NABL-accredited lab" says the lab is credible; it is product testing only when the text says the product was tested there. On its own it is facility/licence.
- Indian whey listings often advertise a nitrogen or amino "spiking" check, and protein-accuracy testing. Record those as protein_spiking and protein_accuracy, not as generic third_party_lab.
- Each entry needs the verbatim quote it came from. If you cannot quote it, do not record it.
Return only what the text supports. Empty lists are the right answer for most listings.`;

const SCHEMA = { type: "object", additionalProperties: false, properties: {
  productTesting: { type: "array", description: "tests the FINISHED product is said to undergo", items: { type: "object", additionalProperties: false, properties: {
    kind: { type: "string", enum: [
      "third_party_lab",      // sent to an outside lab, unspecified what for
      "heavy_metals",         // lead, arsenic, mercury, cadmium
      "banned_substances",    // WADA/NADA prohibited list, for competing athletes
      "microbial",            // total plate count, yeast and mould, E. coli, salmonella
      "potency_assay",        // active actually present at the printed dose
      "protein_accuracy",     // declared protein verified
      "protein_spiking",      // nitrogen/amino spiking check — a live fraud in Indian whey
      "aflatoxin",            // mycotoxins, relevant to herbs and nuts
      "pesticide",            // pesticide and herbicide residue
      "solvent_residue",      // residual extraction solvents in herbal extracts
      "allergen",             // gluten, dairy, soy cross-contamination
      "identity_dna",         // species identity of a botanical
      "adulteration",         // fillers or undeclared substitution
      "radiation",            // radiological screening
      "stability_shelf_life", // shelf-life / accelerated stability
      "other"] },
    programme: { type: ["string", "null"], description: "named certifier or accredited lab if any: Informed Sport, Informed Choice, NSF Certified for Sport, Labdoor, USP Verified, NABL-accredited lab, Eurofins, SGS, Intertek, AOAC method" },
    everyBatch: { type: "boolean", description: "true only if the text says every batch / each lot" },
    quote: { type: "string", description: "short verbatim snippet, max 15 words" } }, required: ["kind", "programme", "everyBatch", "quote"] } },
  purityClaims: { type: "array", description: "'free from' statements, NOT tests", items: { type: "string" } },
  facilityOrLicence: { type: "array", description: "about the factory, the lab or the legal listing — never evidence the product was tested", items: { type: "string", enum: ["fssai", "ayush", "gmp", "cgmp", "haccp", "iso_9001", "iso_22000", "iso_17025", "nabl_accredited_lab", "us_fda_registered", "usda_organic", "india_organic", "halal", "kosher", "other"] } },
  dietFlags: { type: "array", items: { type: "string", enum: ["vegan", "vegetarian", "gluten_free", "sugar_free", "non_gmo", "dairy_free", "lactose_free", "soy_free", "nut_free", "palm_oil_free", "halal", "kosher", "no_artificial_additives"] } },
  ingredientLevel: { type: "array", description: "certifications belonging to an ingredient, not the product", items: { type: "string" } },
  fssaiLicence: { type: ["string", "null"], description: "11-14 digit licence number if printed" } },
  required: ["productTesting", "purityClaims", "facilityOrLicence", "dietFlags", "ingredientLevel", "fssaiLicence"] };

// Only the sentences that mention something worth judging, so each call stays small.
const TRIGGER = /\b(spik|aflatoxin|radiat|solvent|adulterat|halal|kosher|stability|shelf.life|test|tested|testing|verified|certif|lab\b|nabl|labdoor|nsf|informed|wada|nada|dope|doping|banned|heavy metal|coa|certificate of analysis|fssai|ayush|gmp|haccp|iso\s?\d|fda|organic|vegan|vegetarian|gluten|sugar[- ]free|gmo|purity|potency|assay|contaminant|pesticide|allergen)\b/i;
const excerpt = (text) => {
  const t = String(text || "");
  const parts = t.split(/(?<=[.!?•])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (!TRIGGER.test(p)) continue;
    // Many Indian listings are one unpunctuated bullet block, so a whole "sentence" can run
    // past 300 characters. Take a window around each match instead of dropping the block.
    if (p.length <= 320) { out.push(p); continue; }
    const re = new RegExp(TRIGGER.source, "gi");
    let m;
    while ((m = re.exec(p)) && out.length < 18) {
      out.push(p.slice(Math.max(0, m.index - 130), m.index + m[0].length + 130).trim());
      re.lastIndex = m.index + m[0].length + 130;
    }
  }
  return [...new Set(out)].slice(0, 18).join(" … ").slice(0, 2000);
};

(async () => {
  fs.mkdirSync(JUDGED, { recursive: true });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");
  const shop = JSON.parse(fs.readFileSync(path.join(OUT, "bulk/input.json")))
    .map((r) => ({ key: `${r.store}__${r.id}`, title: r.title, text: excerpt(`${r.title}. ${strip(r.bodyHtml)}`) }));
  const amzPath = path.join(OUT, "amazon/prepared.json");
  const amz = fs.existsSync(amzPath) ? JSON.parse(fs.readFileSync(amzPath))
    .map((r) => ({ key: `amazon__${r.asin}`, title: r.title, text: excerpt([r.title, r.description, r.safetyInfo, ...(r.features || [])].filter(Boolean).join(". ")) })) : [];

  // Only products that survived cleaning are worth paying for; the raw pulls are full of
  // bundles and gear that never reach the catalogue.
  const catPath = path.join(OUT, "catalog.json");
  let keep = null;
  if (fs.existsSync(catPath)) {
    keep = new Set();
    for (const p of JSON.parse(fs.readFileSync(catPath))) {
      keep.add(p.key);
      if (p.asin) keep.add(`amazon__${p.asin}`);
    }
  }
  let todo = [...shop, ...amz].filter((r) => r.text.length > 40 && (!keep || keep.has(r.key)));
  if (!FORCE) todo = todo.filter((r) => !fs.existsSync(path.join(JUDGED, r.key + ".json")));
  const ONLY = flag("--only-file", "");
  if (ONLY) { const want = new Set(JSON.parse(fs.readFileSync(ONLY))); todo = todo.filter((r) => want.has(r.key)); }
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log(`${todo.length} listings mention something to judge (model ${MODEL})`);

  let n = 0, tin = 0, tout = 0, withTest = 0;
  const queue = [...todo];
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const r = queue.shift();
      try {
        const res = await openai.chat.completions.create({
          model: MODEL, max_completion_tokens: 900, reasoning_effort: "none",
          messages: [{ role: "system", content: SYS }, { role: "user", content: `Product: ${r.title}\n\nListing text:\n${r.text}` }],
          tools: [{ type: "function", function: { name: "claims", description: "claims", parameters: SCHEMA, strict: true } }],
          tool_choice: { type: "function", function: { name: "claims" } },
        });
        const out = JSON.parse(res.choices[0].message.tool_calls[0].function.arguments);
        tin += res.usage.prompt_tokens; tout += res.usage.completion_tokens;
        if (out.productTesting.length) withTest++;
        fs.writeFileSync(path.join(JUDGED, r.key + ".json"), JSON.stringify(out));
      } catch (e) { console.log(`ERR ${r.key} ${e.message.slice(0, 90)}`); }
      if (++n % 100 === 0) console.log(`  ${n}/${todo.length}, ${withTest} with product testing, in ${tin} out ${tout}`);
    }
  }));
  const pr = { "gpt-6-luna": [0.1, 0.5] }[MODEL] || [0, 0];
  console.log(`\n${n} judged | ${withTest} claim product-level testing | ≈$${((tin * pr[0] + tout * pr[1]) / 1e6).toFixed(3)}`);
})();
