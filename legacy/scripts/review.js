// Second-read QA of bulk/clean.json with a cheap OpenAI vision model.
// Usage: node review.js [--model gpt-5.4-mini] [--limit N] [--conc 4] [--force]
// Writes bulk/review2/<key>.json per item + bulk/review2/_summary.json
const fs = require("fs"), path = require("path"), OpenAI = require("openai");
for (const root of [path.join(__dirname, "../../.."), path.join(__dirname, "../../../../../..")]) { if (fs.existsSync(path.join(root, ".env"))) { require("dotenv").config({ path: path.join(root, ".env"), quiet: true }); require("dotenv").config({ path: path.join(root, ".env.local"), override: true, quiet: true }); break; } }
const flag = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const MODEL = flag("--model", "gpt-6-luna"), LIMIT = +flag("--limit", 0), CONC = +flag("--conc", 4), FORCE = process.argv.includes("--force");
// Reasoning models take reasoning_effort; the mini/nano line rejects it alongside function tools.
const REASONING = /^gpt-(5\.[56]|6)[.-]/.test(MODEL) ? { reasoning_effort: "none" } : {};
const BULK = path.join(__dirname, "../../e2e/out/products/bulk"), OUT = path.join(BULK, "review2");
fs.mkdirSync(OUT, { recursive: true });

const SYS = `You are auditing a supplement product record that was extracted from label photos. You get the label photo(s) and the extracted record.
Check ONLY against what is visible in the photos (and the title). Report:
- amount/unit errors on ingredient rows (wrong number, wrong unit, per-100g copied as per-serving, group total copied to members)
- actives printed on the label but missing from the rows
- rows that are NOT on the label (invented from description)
- wrong servingSize / servingsPerContainer / formFactor
- listing is not actually a consumable supplement (topical, gear, food item)
verdict: ok = nothing material wrong; minor = small naming/unit-basis nits, amounts right; major = any amount wrong, active missing/invented, or not a supplement.
If the photos show no readable supplement-facts panel, say so with verdict "no_label" and list nothing as wrong.
Be strict on numbers, lenient on naming.`;
const SCHEMA = { type: "object", additionalProperties: false, properties: {
  verdict: { type: "string", enum: ["ok", "minor", "major", "no_label"] },
  notSupplement: { type: "boolean" },
  issues: { type: "array", items: { type: "object", additionalProperties: false, properties: {
    kind: { type: "string", enum: ["wrong_amount", "missing_active", "invented_row", "wrong_serving", "wrong_form", "other"] },
    row: { type: ["string", "null"], description: "printedName of the affected row, or null" },
    extracted: { type: ["string", "null"] }, label: { type: ["string", "null"], description: "what the label actually shows" },
    note: { type: "string" } }, required: ["kind", "row", "extracted", "label", "note"] } },
  confidence: { type: "number" } }, required: ["verdict", "notSupplement", "issues", "confidence"] };

const rowTxt = (r) => `${r.role}: ${r.printedName}${r.canonical !== r.printedName ? ` (${r.canonical})` : ""} = ${r.amount ?? "?"} ${r.unit ?? ""}${r.isPartOfBlend ? ` [blend ${r.blendName}]` : ""}${r.standardization ? ` std ${r.standardization}` : ""} <${r.source}>`;

async function one(openai, p) {
  const imgs = (p.labelImages.length ? p.labelImages : [p.imageUrl]).slice(0, 3).map((u) => ({ type: "image_url", image_url: { url: u.replace(/(\?.*)?$/, "?width=1600"), detail: "high" } }));
  const text = `Title: ${p.title}\nBrand: ${p.brand} | Product: ${p.productName}\nformFactor: ${p.formFactor} | servingSize: ${p.servingSize} | servingsPerContainer: ${p.servingsPerContainer} | net: ${p.netQuantity}\nRows (${p.ingredients.length}):\n${p.ingredients.map(rowTxt).join("\n")}`;
  const res = await openai.chat.completions.create({ model: MODEL, max_completion_tokens: 2500, ...REASONING,
    messages: [{ role: "system", content: SYS }, { role: "user", content: [...imgs, { type: "text", text }] }],
    tools: [{ type: "function", function: { name: "audit", description: "audit", parameters: SCHEMA, strict: true } }], tool_choice: { type: "function", function: { name: "audit" } } });
  return { out: JSON.parse(res.choices[0].message.tool_calls[0].function.arguments), usage: res.usage };
}

(async () => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let todo = JSON.parse(fs.readFileSync(path.join(BULK, "clean.json"), "utf8"));
  if (!FORCE) todo = todo.filter((p) => !fs.existsSync(path.join(OUT, p.key + ".json")));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  let i = 0, tin = 0, tout = 0; const t = { ok: 0, minor: 0, major: 0, no_label: 0, err: 0 };
  await Promise.all(Array.from({ length: CONC }, async () => { while (todo.length) { const p = todo.shift(); try {
    const { out, usage } = await one(openai, p); tin += usage.prompt_tokens; tout += usage.completion_tokens; t[out.verdict]++;
    fs.writeFileSync(path.join(OUT, p.key + ".json"), JSON.stringify({ key: p.key, title: p.title, model: MODEL, ...out }, null, 1));
    console.log(`[${++i}] ${out.verdict.padEnd(8)} c=${out.confidence} iss=${out.issues.length} ${p.store} ${p.title.slice(0, 60)}`);
  } catch (e) { t.err++; console.log(`[${++i}] ERR ${p.key} ${e.message.slice(0, 120)}`); } } }));
  console.log(`${i} reviewed ${JSON.stringify(t)} tokens in ${tin} out ${tout}`);
})();
