#!/usr/bin/env node
// Read the certification and testing marks PRINTED ON THE PACK, which the listing text
// routinely omits (Naturyz shows GMP, HACCP, FSSAI and Dope Free as logos and mentions none
// of them in 1,833 characters of description).
// Input: the tiles the classifier already identified as the facts panel, plus the front shot,
// at full resolution. A 320px contact sheet was measured to find fewer marks and misread them.
// Usage: node marks.js [--limit N] [--conc 6] [--force]
// Out: scripts/e2e/out/products/bulk/marks/<key>.json
const fs = require("fs"), path = require("path"), OpenAI = require("openai");
{ const fs0 = require("fs");
  for (const root of [path.join(__dirname, "../../.."), path.join(__dirname, "../../../../../..")]) {
    if (fs0.existsSync(path.join(root, ".env"))) { require("dotenv").config({ path: path.join(root, ".env"), quiet: true }); require("dotenv").config({ path: path.join(root, ".env.local"), override: true, quiet: true }); break; } } }
const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MODEL = flag("--model", "gpt-6-luna"), LIMIT = Number(flag("--limit", 0)), CONC = Number(flag("--conc", 6));
const FORCE = args.includes("--force");
const OUT = path.join(__dirname, "../../e2e/out/products");
const DIR = path.join(OUT, "bulk/marks");

const SYS = `You are looking at photos of an Indian supplement's packaging. List ONLY the certification and testing marks that are actually legible in the images: logos, stamps, seals, licence numbers, printed claims on the pack.
Read what is printed. Never infer a mark from the brand, the product type or the design, and never guess text that is too small or blurred — mark that legible:false instead.
Typical Indian pack marks: the FSSAI logo and its 14-digit licence number, the green dot (vegetarian) or brown dot (non-vegetarian), GMP, HACCP, ISO, FDA registered, AYUSH, USDA Organic, India Organic, Halal, Kosher, Informed Sport, Informed Choice, NSF, Labdoor, "Dope Free", "Banned Substance Tested", "Lab Tested", "Third Party Tested", "Heavy Metals Tested", "No Added Sugar", "Gluten Free", "Vegan".
Do not list marketing lines that are not certification or testing claims ("clinically proven results", "trusted by athletes", "transparent dosing"), and do not list packaging marks such as recyclability unless asked. Recyclable/plastic-neutral marks go in otherPackMarks.
A pack often prints an FSSAI licence for the marketer and another for the manufacturer; record both with their role rather than picking one.
Also copy out the allergen statement if the pack prints one. Indian packs carry two different kinds and they must not be merged: what the product CONTAINS ("Contains Milk", "Contains Soy") and what the SHARED FACILITY may introduce ("Manufactured in a facility that may contain traces of Soy and Nuts", "may contain traces of"). Quote the sentence verbatim as well, since an allergy decision should rest on the exact wording.`;
const SCHEMA = { type: "object", additionalProperties: false, properties: {
  testingMarks: { type: "array", description: "printed testing claims and third-party programmes", items: { type: "object", additionalProperties: false, properties: {
    mark: { type: "string", description: "as printed" },
    kind: { type: "string", enum: ["third_party_lab", "heavy_metals", "banned_substances", "microbial", "potency_assay", "protein_spiking", "pesticide", "allergen", "other"] },
    legible: { type: "boolean" } }, required: ["mark", "kind", "legible"] } },
  certificationMarks: { type: "array", description: "facility, licence and standards marks", items: { type: "object", additionalProperties: false, properties: {
    mark: { type: "string" },
    legible: { type: "boolean" } }, required: ["mark", "legible"] } },
  dietMarks: { type: "array", items: { type: "string", enum: ["vegetarian_green_dot", "non_vegetarian_brown_dot", "vegan", "gluten_free", "sugar_free", "halal", "kosher", "non_gmo", "organic"] } },
  fssaiLicences: { type: "array", description: "Indian packs usually print two, the marketer's and the manufacturer's. Capture each with whose it is.", items: { type: "object", additionalProperties: false, properties: {
    number: { type: "string", description: "digits only, normally 14" },
    role: { type: "string", enum: ["marketed_by", "manufactured_by", "packed_by", "imported_by", "unknown"] } }, required: ["number", "role"] } },
  allergens: { type: "object", additionalProperties: false, description: "the pack's allergen statement, split by what it actually says", properties: {
    contains: { type: "array", description: "allergens the product itself contains", items: { type: "string", enum: ["milk", "soy", "nuts", "peanuts", "gluten", "wheat", "egg", "fish", "shellfish", "sesame", "sulphites", "other"] } },
    mayContainTraces: { type: "array", description: "cross-contamination from a shared facility only", items: { type: "string", enum: ["milk", "soy", "nuts", "peanuts", "gluten", "wheat", "egg", "fish", "shellfish", "sesame", "sulphites", "other"] } },
    freeFrom: { type: "array", description: "allergens the pack explicitly claims to be free from", items: { type: "string" } },
    statement: { type: ["string", "null"], description: "the allergen sentence verbatim, max 200 chars" } },
    required: ["contains", "mayContainTraces", "freeFrom", "statement"] },
  otherPackMarks: { type: "array", items: { type: "string" } },
  illegibleBadgeCount: { type: "number", description: "badges you can see but cannot read" } },
  required: ["testingMarks", "certificationMarks", "dietMarks", "allergens", "fssaiLicences", "otherPackMarks", "illegibleBadgeCount"] };

const big = (u) => u.split("?")[0] + "?width=1600";

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let cat = JSON.parse(fs.readFileSync(path.join(OUT, "catalog.json")))
    .filter((p) => (p.labelImages || []).length || p.imageUrl);
  if (!FORCE) cat = cat.filter((p) => !fs.existsSync(path.join(DIR, p.key + ".json")));
  const ONLY = flag("--only-file", "");
  if (ONLY) { const want = new Set(JSON.parse(fs.readFileSync(ONLY))); cat = cat.filter((p) => want.has(p.key)); }
  if (LIMIT) cat = cat.slice(0, LIMIT);
  console.log(`${cat.length} products to read pack marks from (${MODEL})`);
  let n = 0, tin = 0, tout = 0, withTest = 0, withLic = 0, withAllergen = 0;
  const queue = [...cat];
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const p = queue.shift();
      const imgs = [...(p.labelImages || []).slice(0, 2), ...(p.imageUrl ? [p.imageUrl] : [])]
        .map((u) => ({ type: "image_url", image_url: { url: big(u), detail: "high" } }));
      try {
        const r = await openai.chat.completions.create({
          model: MODEL, max_completion_tokens: 800, reasoning_effort: "none",
          messages: [{ role: "system", content: SYS }, { role: "user", content: [...imgs, { type: "text", text: p.title }] }],
          tools: [{ type: "function", function: { name: "pack_marks", description: "pack_marks", parameters: SCHEMA, strict: true } }],
          tool_choice: { type: "function", function: { name: "pack_marks" } },
        });
        const out = JSON.parse(r.choices[0].message.tool_calls[0].function.arguments);
        tin += r.usage.prompt_tokens; tout += r.usage.completion_tokens;
        if (out.testingMarks.some((m) => m.legible)) withTest++;
        if (out.fssaiLicences?.length) withLic++;
        if (out.allergens?.contains?.length || out.allergens?.mayContainTraces?.length) withAllergen++;
        fs.writeFileSync(path.join(DIR, p.key + ".json"), JSON.stringify(out));
      } catch (e) { console.log(`ERR ${p.key} ${e.message.slice(0, 80)}`); }
      if (++n % 100 === 0) console.log(`  ${n}/${cat.length} | ${withTest} with a testing mark | ${withLic} licence numbers | in ${tin} out ${tout}`);
    }
  }));
  const pr = { "gpt-6-luna": [0.1, 0.5] }[MODEL] || [0, 0];
  console.log(`\n${n} read | ${withTest} show a testing mark | ${withLic} FSSAI licences | ${withAllergen} declare allergens | ≈$${((tin * pr[0] + tout * pr[1]) / 1e6).toFixed(2)}`);
})();
