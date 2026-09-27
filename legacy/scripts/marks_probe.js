#!/usr/bin/env node
// Which input finds certification marks better: the label tiles at full resolution, or the
// whole contact sheet at 320px per tile? Runs both on the same products and prints the diff.
// Usage: node marks_probe.js [--n 20]
const fs = require("fs"), path = require("path"), OpenAI = require("openai");
{ const fs0 = require("fs");
  for (const root of [path.join(__dirname, "../../.."), path.join(__dirname, "../../../../../..")]) {
    if (fs0.existsSync(path.join(root, ".env"))) { require("dotenv").config({ path: path.join(root, ".env"), quiet: true }); require("dotenv").config({ path: path.join(root, ".env.local"), override: true, quiet: true }); break; } } }
const args = process.argv.slice(2);
const N = Number((args.includes("--n") ? args[args.indexOf("--n") + 1] : 20));
const OUT = path.join(__dirname, "../../e2e/out/products");
const MODEL = "gpt-6-luna";

const SYS = `You are looking at photos of an Indian supplement's packaging. List ONLY the certification and testing marks that are actually legible in the images: logos, stamps, seals, licence numbers, printed claims on the pack.
Read what is printed. Do not infer a mark from the brand, the product type or the design. If text is too small or blurred to read, do not guess it.
Typical Indian pack marks: FSSAI logo and 14-digit licence number, the green dot (vegetarian) or brown dot (non-vegetarian), GMP, HACCP, ISO, FDA registered, AYUSH, USDA/India Organic, Halal, Kosher, Informed Sport, Informed Choice, NSF, Labdoor, "Dope Free"/"Banned Substance Tested", "Lab Tested", "Third Party Tested", "No Added Sugar", "Gluten Free", "Vegan", recyclable marks.`;
const SCHEMA = { type: "object", additionalProperties: false, properties: {
  marks: { type: "array", items: { type: "object", additionalProperties: false, properties: {
    mark: { type: "string", description: "as printed, e.g. \"FSSAI\", \"Dope Free\", \"GMP Certified\"" },
    legible: { type: "boolean", description: "false when you can see a badge but cannot read it" } }, required: ["mark", "legible"] } },
  fssaiLicence: { type: ["string", "null"] },
  vegMark: { type: ["string", "null"], enum: ["green", "brown", null] } },
  required: ["marks", "fssaiLicence", "vegMark"] };

const b64 = (p) => `data:image/jpeg;base64,${fs.readFileSync(p).toString("base64")}`;
const big = (u) => u.split("?")[0] + "?width=1600";

async function ask(openai, content) {
  const r = await openai.chat.completions.create({
    model: MODEL, max_completion_tokens: 700, reasoning_effort: "none",
    messages: [{ role: "system", content: SYS }, { role: "user", content }],
    tools: [{ type: "function", function: { name: "marks", description: "marks", parameters: SCHEMA, strict: true } }],
    tool_choice: { type: "function", function: { name: "marks" } },
  });
  return { out: JSON.parse(r.choices[0].message.tool_calls[0].function.arguments), usage: r.usage };
}

(async () => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const cat = JSON.parse(fs.readFileSync(path.join(OUT, "catalog.json")))
    .filter((p) => (p.labelImages || []).length && p.sources?.includes("shopify"))
    .slice(0, N);
  let tin = 0, tout = 0;
  const rows = [];
  for (const p of cat) {
    const gridPath = path.join(OUT, "bulk/extracted", `${p.key}.grid.jpg`);
    const tileContent = [...(p.labelImages || []).slice(0, 2).map((u) => ({ type: "image_url", image_url: { url: big(u), detail: "high" } })),
      ...(p.imageUrl ? [{ type: "image_url", image_url: { url: big(p.imageUrl), detail: "high" } }] : []),
      { type: "text", text: p.title }];
    const gridContent = fs.existsSync(gridPath)
      ? [{ type: "image_url", image_url: { url: b64(gridPath), detail: "high" } }, { type: "text", text: `${p.title} (contact sheet of every listing photo)` }]
      : null;
    try {
      const a = await ask(openai, tileContent);
      tin += a.usage.prompt_tokens; tout += a.usage.completion_tokens;
      let b = null;
      if (gridContent) { b = await ask(openai, gridContent); tin += b.usage.prompt_tokens; tout += b.usage.completion_tokens; }
      const legible = (o) => o.out.marks.filter((m) => m.legible).map((m) => m.mark.toLowerCase());
      const A = legible(a), B = b ? legible(b) : [];
      rows.push({ title: p.title.slice(0, 42), tiles: A, grid: B, licA: a.out.fssaiLicence, licB: b?.out.fssaiLicence });
      console.log(`${p.title.slice(0, 38).padEnd(40)} tiles ${String(A.length).padStart(2)} | grid ${String(B.length).padStart(2)}`);
    } catch (e) { console.log("ERR", p.key, e.message.slice(0, 70)); }
  }
  const onlyTiles = new Set(), onlyGrid = new Set();
  let tl = 0, gl = 0, licA = 0, licB = 0;
  for (const r of rows) {
    tl += r.tiles.length; gl += r.grid.length;
    if (r.licA) licA++; if (r.licB) licB++;
    r.tiles.filter((m) => !r.grid.includes(m)).forEach((m) => onlyTiles.add(m));
    r.grid.filter((m) => !r.tiles.includes(m)).forEach((m) => onlyGrid.add(m));
  }
  console.log(`\n${rows.length} products | legible marks: label tiles ${tl}, contact sheet ${gl}`);
  console.log(`FSSAI licence read: tiles ${licA}, sheet ${licB}`);
  console.log(`only from tiles : ${[...onlyTiles].slice(0, 14).join(", ")}`);
  console.log(`only from sheet : ${[...onlyGrid].slice(0, 14).join(", ")}`);
  const pr = [0.1, 0.5];
  console.log(`tokens in ${tin} out ${tout} ≈$${((tin * pr[0] + tout * pr[1]) / 1e6).toFixed(3)} for both passes`);
  fs.writeFileSync(path.join(OUT, "bulk/marks_probe.json"), JSON.stringify(rows, null, 1));
})();
