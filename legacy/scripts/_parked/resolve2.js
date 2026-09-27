#!/usr/bin/env node
// Resolve ACTIVE rows from extracted2 → supp_ingredients slug.
// Step 1: textMatch candidates (top 5, read-only SELECT on dev DB; no gap tally here).
// Step 2: exact/alias hits auto-accept. Everything else: one cheap LLM call per product picks a slug from the
//         candidate list (or "none"), so the words/fuzzy tiers are never trusted blindly.
// Output: scripts/e2e/out/products/verify/resolved2.json + console summary.
// Needs DATABASE_URL_V2 (dev, read-only) and OPENAI_API_KEY in env.
{ const p = require("path"); const fs0 = require("fs");
  for (const root of [p.join(__dirname, "../../../.."), p.join(__dirname, "../../../../../../..")]) {
    if (fs0.existsSync(p.join(root, ".env"))) { require("dotenv").config({ path: p.join(root, ".env"), quiet: true }); require("dotenv").config({ path: p.join(root, ".env.local"), override: true, quiet: true }); break; } } }
const fs = require("fs");
const path = require("path");
const { sql } = require("drizzle-orm");
const OpenAI = require("openai");
const { db } = require("../../../../src/db");
const textMatch = require("../../../../src/services/textMatch");

const MODEL = process.env.SUPP_EXTRACT_MODEL || "gpt-5.6-luna";
const IN = path.join(__dirname, "../../../e2e/out/products/verify/extracted2");
const OUT = path.join(__dirname, "../../../e2e/out/products/verify/resolved2.json");

async function candidates(q) {
  const m = textMatch.matchFragments({ q, nameCol: sql`name`, aliasesCol: sql`aliases` });
  if (!m) return [];
  const res = await db.execute(sql`SELECT slug, name, category, ${m.score} AS score, ${m.kind} AS "matchKind" FROM supp_ingredients WHERE ${m.where} ORDER BY ${m.orderBy} LIMIT 5`);
  return textMatch.pruneFuzzy(res.rows);
}

const PICK_SYS = `You map supplement label ingredients to a fixed catalog of ingredient slugs. For each item you get the printed label text, a generic name, and candidate catalog entries. Pick the candidate that IS that ingredient (same substance; a specific form of it is fine: "magnesium bisglycinate" → magnesium, "KSM-66 ashwagandha" → ashwagandha, "biotin" → vitamin_b7, "L-leucine" → leucine only if a leucine entry exists). Pick "none" when no candidate is the same substance (e.g. sodium is not iron, leucine is not glycine, saturated fat is not omega_3). Never guess.`;
const PICK_SCHEMA = { type: "object", additionalProperties: false, properties: { picks: { type: "array", items: { type: "object", additionalProperties: false, properties: { i: { type: "number" }, slug: { type: "string", description: "a candidate slug, or \"none\"" } }, required: ["i", "slug"] } } }, required: ["picks"] };

(async () => {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const out = [];
  const tally = { auto: 0, llm_pick: 0, llm_none: 0, no_candidates: 0 };
  let tokIn = 0, tokOut = 0;
  for (const f of fs.readdirSync(IN).filter((f) => f.endsWith(".json"))) {
    const r = JSON.parse(fs.readFileSync(path.join(IN, f)));
    if (!r.facts) continue;
    const actives = r.facts.rows.filter((x) => x.role === "active");
    const pending = [];
    for (const ing of actives) {
      let rows = await candidates(ing.canonical);
      if (!rows.length) rows = await candidates(ing.printedName);
      const row = { product: r.title, store: r.store, printed: ing.printedName, canonical: ing.canonical, amount: ing.amount, unit: ing.unit, basis: ing.amountBasis, blend: ing.isPartOfBlend, candidates: rows.map((x) => x.slug), slug: null, how: null };
      const top = rows[0];
      if (top && (top.matchKind === "exact" || top.matchKind === "alias")) { row.slug = top.slug; row.how = "auto"; tally.auto++; }
      else if (!rows.length) { row.how = "no_candidates"; tally.no_candidates++; }
      else pending.push({ row, rows });
      out.push(row);
    }
    if (pending.length) {
      const text = pending.map((p, i) => `${i}. printed: "${p.row.printed}" | generic: "${p.row.canonical}" | candidates: ${p.rows.map((c) => `${c.slug} (${c.name})`).join(", ")}`).join("\n");
      const res = await openai.chat.completions.create({ model: MODEL, max_completion_tokens: 800, ...(MODEL.startsWith("gpt-5") ? { reasoning_effort: "none" } : { temperature: 0 }),
        messages: [{ role: "system", content: PICK_SYS }, { role: "user", content: text }],
        tools: [{ type: "function", function: { name: "pick", description: "pick", parameters: PICK_SCHEMA, strict: true } }], tool_choice: { type: "function", function: { name: "pick" } } });
      tokIn += res.usage.prompt_tokens; tokOut += res.usage.completion_tokens;
      const picks = JSON.parse(res.choices[0].message.tool_calls[0].function.arguments).picks;
      for (const pk of picks) { const p = pending[pk.i]; if (!p) continue; if (pk.slug !== "none" && p.rows.some((c) => c.slug === pk.slug)) { p.row.slug = pk.slug; p.row.how = "llm_pick"; tally.llm_pick++; } else { p.row.how = "llm_none"; tally.llm_none++; } }
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(tally, "of", out.length, "active rows; pick tokens in", tokIn, "out", tokOut);
  console.log("\nUNRESOLVED (gap queue candidates):");
  for (const o of out.filter((o) => !o.slug)) console.log(" ", o.how.padEnd(14), `"${o.canonical}"`.padEnd(36), "←", o.printed.slice(0, 45).padEnd(47), "cands:", o.candidates.join(","));
  console.log("\nLLM PICKS:");
  for (const o of out.filter((o) => o.how === "llm_pick")) console.log(" ", `"${o.canonical}"`.padEnd(36), "→", o.slug, "  of", o.candidates.join(","));
  process.exit(0);
})();
