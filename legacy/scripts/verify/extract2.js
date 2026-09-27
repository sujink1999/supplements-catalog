#!/usr/bin/env node
// Two-call extraction. Call 1 (contact sheet of ALL images + title/type/variants): classify listing
// (supplement / not, single / bundle / multipack / value-pack) and pick the tiles showing the facts panel.
// Call 2 (chosen tiles at full res + description text): supplement facts, one row per printed ingredient,
// each tagged active | macro | excipient; blends expanded per component.
// Cache: scripts/e2e/out/products/verify/extracted2/<store>__<id>.json. Grid jpeg saved alongside for review.
// Usage: node extract2.js [--model gpt-5.6-luna] [--limit N] [--force] [--in sample.json]
{ const p = require("path"); const fs0 = require("fs");
  for (const root of [p.join(__dirname, "../../../.."), p.join(__dirname, "../../../../../../..")]) {
    if (fs0.existsSync(p.join(root, ".env"))) { require("dotenv").config({ path: p.join(root, ".env"), quiet: true }); require("dotenv").config({ path: p.join(root, ".env.local"), override: true, quiet: true }); break; } } }
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { contactSheet } = require("./grid");

const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MODEL = flag("--model", process.env.SUPP_EXTRACT_MODEL || "gpt-6-luna");
const LIMIT = Number(flag("--limit", 9999));
const FORCE = args.includes("--force");
const IN = path.resolve(flag("--in", path.join(__dirname, "../../../e2e/out/products/verify/sample.json")));
const OUT = path.resolve(flag("--out", path.join(__dirname, "../../../e2e/out/products/verify/extracted2")));
const ONLY = (flag("--only", "") || "").split(",").map((x) => x.trim()).filter(Boolean);
const CONC = Number(flag("--conc", 1));
const BATCH = Number(flag("--batch", 0));
const EFFORT = flag("--effort", "none"); // none|low|medium|high — reasoning tokens bill as output
// $ per 1M tokens [input, output]. null = unknown, cost line then prints "n/a".
const PRICE = { "gpt-6-luna": [0.1, 0.5], "gpt-6-sol": [2, 10], "gpt-6-astra": [10, 50], "gpt-5.6-luna": [0.2, 1.2], "gpt-5.6-sol": [4, 20], "gpt-5.4-mini": [0.75, 4.5] };

const CLASSIFY_SYS = `You see a contact sheet of every listing photo for one product from an Indian online store, numbered 0..N, plus the listing title and variants. Decide what the listing is and which photos show the supplement facts / ingredients panel.
Listing kinds:
- supplement: a dietary supplement (capsules, tablets, powder, gummies, sachets, effervescent, oil, drops, protein, creatine, electrolytes).
- not_supplement: apparel, gear, shaker, cosmetics, skincare, period care, ordinary food/snack, plain beverage, equipment, gift card, accessory.
A protein bar IS a supplement when it is sold for a stated protein dose (the title or pack names the grams, e.g. "20g Protein Bar"): treat it as a supplement with formFactor "bar". An energy bar, granola/muesli bar, millet bar, snack bar, date-and-nut bar or meal bar sold as food is NOT a supplement, even though it prints a nutrition panel - no stated active dose, no measured daily serving. A bar whose only claim is calories, fibre or "wholesome ingredients" is food.
  India-specific: a drinkable ayurvedic preparation IS a supplement, not a beverage — juice, ras, kwath, kadha, syrup, tonic, asava, arishta, shot, "chyawanprash"-style paste — when it is taken in a measured daily dose (e.g. 30 ml twice daily) for a health benefit. Judge by dose, not by container: a 1 L bottle taken 30 ml at a time is a supplement; a drink consumed by the glass is not. Seeds, nuts, flours, oats, ghee and honey sold as food stay not_supplement.
Pack kinds (only for supplements):
- single: one product. NOTE "Pack of 30 sachets/sticks/shots/gummies" is a SINGLE product whose container holds 30 single-dose units; report that count in unitsInContainer.
- multipack: N copies of the same container ("Pack of 2", "2 x 60 caps", "Buy 2 Get 1").
- bundle: two or more DIFFERENT products sold together (combo/kit/stack with distinct product names).
- value_pack: the same product in a bigger fill size ("Value Pack 2 kg"); treat as single.
Bundle rule: decide pack from the TITLE and VARIANT names first, not from how many boxes appear in a photo. Brands photograph one product from several angles and next to props. Every name you put in bundleComponents MUST appear in the title or a variant name; if you cannot name two distinct products from that text, the listing is single.
labelTiles: tile numbers showing a supplement facts / nutrition information / ingredients table (typically a back-of-pack shot or a "facts" infographic with per-serving amounts). Best tile first. Empty if none. Ignore lifestyle photos, benefit infographics without amounts, and front-of-pack shots.
labelTileKinds: one entry per labelTiles entry, in the same order. "pack_photo" = a photograph of the physical pack, where the panel is printed on the bottle, pouch or carton itself (it curves, catches light, sits at an angle, or is surrounded by the rest of the pack). "spec_graphic" = a flat rendered image the brand designed for the listing, where the panel is typeset on a plain background with no packaging around it. Brands routinely publish a spec graphic whose numbers disagree with the pack they actually ship, so this distinction decides which numbers we keep.`;
const CLASSIFY_SCHEMA = { type: "object", additionalProperties: false, properties: {
  listing: { type: "string", enum: ["supplement", "not_supplement"] },
  pack: { type: "string", enum: ["single", "multipack", "bundle", "value_pack", "n/a"] },
  unitsInContainer: { type: ["number", "null"], description: "for single-dose units (sachet/stick/gummy/tablet/capsule) the count per container if visible, else null" },
  bundleComponents: { type: "array", items: { type: "string" }, description: "distinct product names, only when pack=bundle" },
  labelTiles: { type: "array", items: { type: "number" } },
  labelTileKinds: { type: "array", items: { type: "string", enum: ["pack_photo", "spec_graphic"] } },
  frontTile: { type: ["number", "null"] },
  reason: { type: "string" } }, required: ["listing", "pack", "unitsInContainer", "bundleComponents", "labelTiles", "labelTileKinds", "frontTile", "reason"] };

const FACTS_SYS = `You read the supplement facts of one Indian dietary supplement from its label photo(s) and listing text. Return the facts exactly as printed.
- The label photo is the source of truth for amounts; description text second; title last.
- You may be given more than one panel, and they may disagree. The photographed physical pack ALWAYS wins over a flat rendered spec graphic: the pack is what ships. Images are ordered pack photos first, so where two panels print different numbers for the same line, take the number from the earliest image that shows that line, and say in notes which lines disagreed and by how much. Never invent an amount: if not printed, amount null and say so in notes.
- One row per line printed on the label. role: "active" (vitamins, minerals, herbs, amino acids, probiotics, protein as a product, creatine, etc.), "macro" (energy/kcal, protein/carbs/fat/sugar/fibre/sodium lines of a nutrition table, the amino-acid profile of a protein powder), "excipient" (capsule shell, fillers, flavour, sweetener, anti-caking, preservatives, colour).
- Protein powders / gainers / creatine / electrolytes: the headline nutrient IS the active. Emit an "active" row for it (canonical must name the source: "whey protein", "whey protein isolate", "casein protein", "plant protein", "creatine monohydrate", "sodium", etc.) with the per-serving grams, in addition to the macro lines. The amino-acid profile stays macro.
- Group totals: when the label prints a heading with a total followed by its members (e.g. "Total BCAA 6 g" above leucine/isoleucine/valine, "Total Amino Acids", "Electrolyte Blend"), emit ONE row for the heading carrying the printed total, and rows for the members with amount null and isPartOfBlend true. NEVER copy the group total onto each member.
- A standardization line ("standardised to 5% withanolides") is not its own row: fold it into the herb's row via the standardization field.
- servingsPerContainer and net quantity come from the label in the PHOTO you were given. If the listing text claims a different container size than the photographed pack, trust the photo and note the disagreement.
- Proprietary blends: one row per component with isPartOfBlend true and blendName; component amount null unless printed; put the printed blend total in blendTotalMg on each component row. Never collapse a blend into one row.
- printedName = exact label text (with form and standardization). canonical = plain generic ingredient name, no dose, no form, no brand, no trademark ("KSM-66 Ashwagandha root extract 600 mg" → canonical "ashwagandha", form "root extract", standardization "5% withanolides" if printed).
- Indian ingredient lists often print a percentage of the formula instead of a weight ("Dates 7%", "Alkalized Cocoa 6%"). Report it as printed: amount 7, unit "%". NEVER convert a percentage into grams or milligrams yourself, even when the serving size is known - a converted number is not what the label says.
- amount is PER SERVING as the label defines the serving. servingSize verbatim ("2 capsules", "1 sachet (5 g)"). servingsPerContainer from the label if printed, else derive from net quantity / serving size and say so in notes.
- amountBasis: "elemental" when the label gives the mineral itself or says "as X" / "elemental"; "compound" when it lists the salt weight ("Magnesium glycinate 1000 mg"); "unknown" if unclear.
- Probiotics: unit "CFU" with amount as a number (e.g. 10 billion → 10000000000, or use unit "billion CFU" with amount 10). Prefer "billion CFU".
- confidence 0-1 for the whole extraction; list every doubt in notes. If no label photo was provided, work from text only and cap confidence at 0.5.`;
const FACTS_SCHEMA = { type: "object", additionalProperties: false, properties: {
  brand: { type: "string" }, productName: { type: "string" }, formFactor: { type: ["string", "null"], description: "capsule | tablet | powder | gummy | sachet | effervescent | liquid | softgel | stick | bar | other" },
  servingSize: { type: ["string", "null"] }, servingsPerContainer: { type: ["number", "null"] }, netQuantity: { type: ["string", "null"] }, doseDirections: { type: ["string", "null"] },
  rows: { type: "array", items: { type: "object", additionalProperties: false, properties: {
    role: { type: "string", enum: ["active", "macro", "excipient"] },
    printedName: { type: "string" }, canonical: { type: "string" },
    amount: { type: ["number", "null"] }, unit: { type: ["string", "null"] }, amountBasis: { type: "string", enum: ["elemental", "compound", "unknown"] },
    form: { type: ["string", "null"] }, standardization: { type: ["string", "null"] },
    isPartOfBlend: { type: "boolean" }, blendName: { type: ["string", "null"] }, blendTotalMg: { type: ["number", "null"] },
    source: { type: "string", enum: ["label_image", "description", "title"] } },
    required: ["role", "printedName", "canonical", "amount", "unit", "amountBasis", "form", "standardization", "isPartOfBlend", "blendName", "blendTotalMg", "source"] } },
  confidence: { type: "number" }, notes: { type: "string" } },
  required: ["brand", "productName", "formFactor", "servingSize", "servingsPerContainer", "netQuantity", "doseDirections", "rows", "confidence", "notes"] };

const strip = (h) => (h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const b64 = (buf) => `data:image/jpeg;base64,${buf.toString("base64")}`;

// Two transports. chat.completions + function tool is the cheap default, but it rejects
// reasoning_effort; anything above "none" has to go through /v1/responses with a json_schema.
async function call(openai, system, content, name, schema, maxTok) {
  const isGpt5plus = /^gpt-(5\.[56]|6)[.-]/.test(MODEL);
  if (isGpt5plus && EFFORT !== "none") {
    const input = [
      { role: "system", content: [{ type: "input_text", text: system }] },
      { role: "user", content: content.map((c) => (c.type === "text"
        ? { type: "input_text", text: c.text }
        : { type: "input_image", image_url: c.image_url.url, detail: c.image_url.detail || "high" })) },
    ];
    const res = await openai.responses.create({
      model: MODEL, input, reasoning: { effort: EFFORT },
      max_output_tokens: Math.max(maxTok, 16000),
      text: { format: { type: "json_schema", name, schema, strict: true } },
    });
    const txt = res.output_text || (res.output || []).flatMap((o) => o.content || []).map((c) => c.text).filter(Boolean).join("");
    if (!txt) throw new Error(`empty response (${res.status || "?"}${res.incomplete_details ? " " + res.incomplete_details.reason : ""})`);
    return { out: JSON.parse(txt), usage: { prompt_tokens: res.usage.input_tokens, completion_tokens: res.usage.output_tokens } };
  }
  const res = await openai.chat.completions.create({
    model: MODEL, max_completion_tokens: maxTok,
    ...(isGpt5plus ? { reasoning_effort: "none" } : { temperature: 0 }),
    messages: [{ role: "system", content: system }, { role: "user", content }],
    tools: [{ type: "function", function: { name, description: name, parameters: schema, strict: true } }],
    tool_choice: { type: "function", function: { name } },
  });
  return { out: JSON.parse(res.choices[0].message.tool_calls[0].function.arguments), usage: res.usage };
}

async function extractOne(openai, p, gridPath) {
  const t0 = Date.now();
  const { buffer, tiles } = await contactSheet(p.images);
  fs.writeFileSync(gridPath, buffer);
  const meta = `Store: ${p.store}\nTitle: ${p.title}\nVendor: ${p.vendor}\nType: ${p.productType || "-"}\nVariants: ${p.variants.map((v) => v.title + " ₹" + v.price).join(" | ")}\nTiles: ${tiles.length} (numbered 0..${tiles.length - 1})`;
  const c1 = await call(openai, CLASSIFY_SYS, [{ type: "image_url", image_url: { url: b64(buffer), detail: "high" } }, { type: "text", text: meta }], "classify_listing", CLASSIFY_SCHEMA, 600);
  const cls = c1.out;
  const usage = { in: c1.usage.prompt_tokens, out: c1.usage.completion_tokens };
  // Image-led bundle false positives: the model sees several boxes in one photo and calls a
  // single product a combo. Demote unless the title/variants actually name the components.
  if (cls.listing === "supplement" && cls.pack === "bundle") {
    const hay = (p.title + " " + p.variants.map((v) => v.title).join(" ")).toLowerCase();
    const comboSignal = /combo|bundle|kit|stack|duo|trio|\+/.test((p.title + " " + (p.productType || "") + " " + (p.tags || []).join(" ")).toLowerCase());
    const stop = new Set(["the", "and", "for", "with", "of", "a", "pack", "capsules", "tablets", "powder", "plus", (p.vendor || "").toLowerCase()]);
    const unnamed = cls.bundleComponents.filter((c) => c.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 2 && !stop.has(w) && !hay.includes(w)));
    if (!comboSignal && (cls.bundleComponents.length < 2 || unnamed.length)) {
      cls.pack = "single";
      cls.reason += ` [code: bundle demoted to single; unnamed components ${JSON.stringify(unnamed)}]`;
    }
  }
  let facts = null, labelImages = [], labelKinds = [];
  if (cls.listing === "supplement" && cls.pack !== "bundle") {
    // The physical pack is the legal label; a spec graphic is marketing that the brand
    // may never have reprinted. Put pack photos first so the model reads them first.
    const picked = cls.labelTiles
      .map((i, n) => ({ src: tiles[i]?.src, kind: cls.labelTileKinds?.[n] || "pack_photo" }))
      .filter((x) => x.src);
    const ordered = [...picked.filter((x) => x.kind === "pack_photo"), ...picked.filter((x) => x.kind !== "pack_photo")].slice(0, 4);
    labelKinds = ordered.map((x) => x.kind);
    labelImages = ordered.map((x) => x.src);
    const content = labelImages.map((src) => ({ type: "image_url", image_url: { url: src.split("?")[0] + "?width=1600", detail: "high" } }));
    content.push({ type: "text", text: `${meta}\n\nDescription:\n${strip(p.bodyHtml).slice(0, 6000)}` });
    const c2 = await call(openai, FACTS_SYS, content, "supplement_facts", FACTS_SCHEMA, 8000);
    facts = c2.out; usage.in += c2.usage.prompt_tokens; usage.out += c2.usage.completion_tokens;
    // A panel under 800px wide is rarely legible; cap confidence so the cleaner can quarantine it.
    const wOf = (src) => (p.images.find((im) => im.src === src) || {}).w || 0;
    const lowRes = labelImages.length > 0 && labelImages.every((src) => wOf(src) > 0 && wOf(src) < 800);
    if (lowRes) {
      facts.lowResLabel = true;
      facts.confidence = Math.min(facts.confidence, 0.6);
      facts.notes = "LOW-RES LABEL (<800px): amounts may be misread. " + (facts.notes || "");
    }
  }
  return { store: p.store, id: p.id, url: p.url, title: p.title, sampleClass: p.sampleClass, model: MODEL, imageCount: p.images.length, tiles, classify: cls, labelImages, labelKinds, facts, usage, ms: Date.now() - t0 };
}

(async () => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  fs.mkdirSync(OUT, { recursive: true });
  let sample = JSON.parse(fs.readFileSync(IN));
  if (ONLY.length) sample = sample.filter((p) => ONLY.includes(String(p.id)) || ONLY.includes(`${p.store}__${p.id}`));
  sample = sample.slice(0, LIMIT);
  const todo = sample.filter((p) => FORCE || !fs.existsSync(path.join(OUT, `${p.store}__${p.id}.json`)));
  if (BATCH) todo.splice(BATCH);
  const total = todo.length;
  console.log(`${total} to do (of ${sample.length}) model=${MODEL} conc=${CONC}`);
  let tokIn = 0, tokOut = 0, n = 0;
  await Promise.all(Array.from({ length: Math.max(1, CONC) }, async () => {
    while (todo.length) {
      const p = todo.shift();
      const base = path.join(OUT, `${p.store}__${p.id}`);
      try {
        const r = await extractOne(openai, p, base + ".grid.jpg");
        fs.writeFileSync(base + ".json", JSON.stringify(r, null, 1));
        tokIn += r.usage.in; tokOut += r.usage.out; n++;
        const f = r.facts;
        console.log(`[${n}/${total}] ${r.classify.listing === "supplement" ? r.classify.pack.padEnd(10) : "NOT_SUPP  "} tiles=${String(r.tiles.length).padStart(2)} label=[${r.classify.labelTiles}] ${f ? `c=${f.confidence} rows=${f.rows.length} act=${f.rows.filter((x) => x.role === "active").length}` : "-"} ${r.ms}ms  ${p.store} ${p.title.slice(0, 55)}`);
      } catch (e) { console.log("ERR    ", p.title.slice(0, 60), e.message); }
    }
  }));
  const pr = PRICE[MODEL];
  const cost = pr ? `≈$${((tokIn * pr[0] + tokOut * pr[1]) / 1e6).toFixed(3)}` : "cost n/a (price for this model not in PRICE)";
  console.log(`\n${n} products, tokens in ${tokIn} out ${tokOut}, ${cost}`);
})();
