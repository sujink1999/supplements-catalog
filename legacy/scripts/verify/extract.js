#!/usr/bin/env node
// LLM extraction of the supplement facts for each sampled product.
// Input: title + description text + up to 3 images. Structured output via function call.
// Cached per product id in scripts/e2e/out/products/verify/extracted/<store>__<id>.json; reruns are free.
// Usage: node extract.js [--model gpt-5.6-luna] [--limit N] [--force]
// Run with 2>&1 | tee /tmp/supp-extract.log
require("dotenv").config({ path: path0() });
function path0() { return require("path").join(__dirname, "../../../../.env"); }
require("dotenv").config({ path: require("path").join(__dirname, "../../../../.env.local"), override: true });
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MODEL = flag("--model", process.env.SUPP_EXTRACT_MODEL || "gpt-5.6-luna");
const LIMIT = Number(flag("--limit", 999));
const FORCE = args.includes("--force");
const IN = path.join(__dirname, "../../../e2e/out/products/verify/sample.json");
const OUT = path.join(__dirname, "../../../e2e/out/products/verify/extracted");
const MAX_IMAGES = 3;

const SYSTEM = `You read Indian dietary supplement listings (title, store description, product photos) and return the supplement facts exactly as the label states them. Rules:
- Use the label/facts-table photo as the source of truth for amounts. Description text is second. Never invent an amount; if the label is unreadable or absent, amount is null and note it.
- One row per ingredient as printed. printedName = the exact text on the label (with form and standardization). canonical = the generic ingredient name in plain English, no dose, no form words, no brand (e.g. "Withania somnifera root extract (5% withanolides) 600 mg" → canonical "ashwagandha", form "root extract", standardization "5% withanolides").
- amount is PER SERVING as the label defines a serving (e.g. 2 capsules). Report servingSize verbatim ("2 capsules", "1 scoop (30 g)").
- amountBasis: "elemental" when the label says elemental / "as X" / gives the mineral itself (e.g. "Magnesium (as magnesium glycinate) 200 mg" → 200 mg elemental); "compound" when it lists the salt weight ("Magnesium glycinate 1000 mg"); "unknown" if unclear.
- Proprietary blends: listed with amount null and isPartOfBlend true, blendName set; if the blend total is printed put it in blendTotalMg.
- Excipients (capsule shell, fillers, flavour, sweetener, anti-caking) go in excipients[], not ingredients[].
- kind: "single" (one active), "multi" (several actives in one product), "bundle" (several separate products sold together), "not_supplement" (food, drink, cosmetic, equipment).
- confidence 0-1 for the whole extraction; list every doubt in notes.
- ratingSeen: if a rating/review count is visible in the text, report it, else null.`;

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["single", "multi", "bundle", "not_supplement"] },
    brand: { type: "string" }, productName: { type: "string" },
    servingSize: { type: ["string", "null"] }, servingsPerContainer: { type: ["number", "null"] },
    doseDirections: { type: ["string", "null"] },
    ingredients: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      printedName: { type: "string" }, canonical: { type: "string" },
      amount: { type: ["number", "null"] }, unit: { type: ["string", "null"] },
      amountBasis: { type: "string", enum: ["elemental", "compound", "unknown"] },
      form: { type: ["string", "null"] }, standardization: { type: ["string", "null"] },
      isPartOfBlend: { type: "boolean" }, blendName: { type: ["string", "null"] }, blendTotalMg: { type: ["number", "null"] },
      source: { type: "string", enum: ["label_image", "description", "title"] },
    }, required: ["printedName", "canonical", "amount", "unit", "amountBasis", "form", "standardization", "isPartOfBlend", "blendName", "blendTotalMg", "source"] } },
    excipients: { type: "array", items: { type: "string" } },
    labelImageIndex: { type: ["number", "null"], description: "index (0-based, in the order given) of the image that shows the facts table, null if none" },
    confidence: { type: "number" }, notes: { type: "string" },
  },
  required: ["kind", "brand", "productName", "servingSize", "servingsPerContainer", "doseDirections", "ingredients", "excipients", "labelImageIndex", "confidence", "notes"],
};

const strip = (h) => (h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
// Prefer images whose alt/filename hints at a label; then the later images (front shot is usually first).
function pickImages(images) {
  const scored = images.map((im, i) => ({ ...im, i, s: /label|fact|ingredient|nutrition|back|supplement|composition|info/i.test((im.alt || "") + " " + im.src) ? 2 : i === 0 ? 0 : 1 }));
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, MAX_IMAGES);
}

async function extractOne(openai, p) {
  const imgs = pickImages(p.images);
  const content = imgs.map((im) => ({ type: "image_url", image_url: { url: im.src.split("?")[0] + "?width=1200", detail: "high" } }));
  content.push({ type: "text", text: `Store: ${p.store}\nTitle: ${p.title}\nVendor: ${p.vendor}\nType: ${p.productType}\nVariants: ${p.variants.map((v) => v.title + " ₹" + v.price).join(" | ")}\n\nDescription:\n${strip(p.bodyHtml).slice(0, 6000)}` });
  const t0 = Date.now();
  const res = await openai.chat.completions.create({
    model: MODEL, max_completion_tokens: 2500,
    ...(MODEL.startsWith("gpt-5") ? { reasoning_effort: "none" } : { temperature: 0 }),
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content }],
    tools: [{ type: "function", function: { name: "supplement_facts", description: "Return the extracted supplement facts.", parameters: SCHEMA, strict: true } }],
    tool_choice: { type: "function", function: { name: "supplement_facts" } },
  });
  const call = res.choices[0]?.message?.tool_calls?.[0];
  const facts = JSON.parse(call.function.arguments);
  return { store: p.store, id: p.id, url: p.url, title: p.title, sampleClass: p.sampleClass, imagesSent: imgs.map((i) => i.src), model: MODEL, usage: res.usage, ms: Date.now() - t0, facts };
}

(async () => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  fs.mkdirSync(OUT, { recursive: true });
  const sample = JSON.parse(fs.readFileSync(IN)).slice(0, LIMIT);
  let tokIn = 0, tokOut = 0, n = 0;
  for (const p of sample) {
    const f = path.join(OUT, `${p.store}__${p.id}.json`);
    if (fs.existsSync(f) && !FORCE) { console.log("cached ", p.title.slice(0, 70)); continue; }
    try {
      const r = await extractOne(openai, p);
      fs.writeFileSync(f, JSON.stringify(r, null, 1));
      tokIn += r.usage.prompt_tokens; tokOut += r.usage.completion_tokens; n++;
      console.log(`${r.facts.kind.padEnd(6)} c=${r.facts.confidence} ing=${r.facts.ingredients.length} ${r.ms}ms  ${p.title.slice(0, 60)}`);
    } catch (e) { console.log("ERR    ", p.title.slice(0, 60), e.message); }
  }
  console.log(`\n${n} calls, tokens in ${tokIn} out ${tokOut}, ≈$${((tokIn * 0.2 + tokOut * 1.2) / 1e6).toFixed(3)} at luna list price`);
})();
