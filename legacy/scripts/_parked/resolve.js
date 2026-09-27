#!/usr/bin/env node
// Resolve extracted ingredient names → supp_ingredients slug via textMatch.
// READ-ONLY against the dev DB (searchIngredients is a SELECT; its gap tally is the only write and is suppressed here).
// Output: scripts/e2e/out/products/verify/resolved.json + console summary
const fs = require("fs");
const path = require("path");
const { sql } = require("drizzle-orm");
const db = require("../../../../src/db");
const textMatch = require("../../../../src/services/textMatch");

const IN = path.join(__dirname, "../../../e2e/out/products/verify/extracted");
const OUT = path.join(__dirname, "../../../e2e/out/products/verify/resolved.json");

async function match(q) {
  const m = textMatch.matchFragments({ q, nameCol: sql`name`, aliasesCol: sql`aliases` });
  if (!m) return [];
  const res = await db.execute(sql`SELECT slug, name, ${m.score} AS score, ${m.kind} AS "matchKind" FROM supp_ingredients WHERE ${m.where} ORDER BY ${m.orderBy} LIMIT 5`);
  return textMatch.pruneFuzzy(res.rows);
}

(async () => {
  const out = [];
  const tally = { hit: 0, words: 0, fuzzy: 0, miss: 0 };
  for (const f of fs.readdirSync(IN)) {
    const r = JSON.parse(fs.readFileSync(path.join(IN, f)));
    for (const ing of r.facts.ingredients) {
      let rows = await match(ing.canonical);
      let via = "canonical";
      if (!rows.length || textMatch.isMiss(rows)) { const r2 = await match(ing.printedName); if (r2.length && !textMatch.isMiss(r2)) { rows = r2; via = "printed"; } }
      const top = rows[0];
      const tier = !top ? "miss" : textMatch.isMiss(rows) ? "fuzzy" : top.matchKind === "exact" || top.matchKind === "alias" || top.matchKind === "phrase" ? "hit" : "words";
      tally[tier]++;
      out.push({ product: r.title, store: r.store, printed: ing.printedName, canonical: ing.canonical, amount: ing.amount, unit: ing.unit, basis: ing.amountBasis, tier, via, slug: top?.slug || null, matchKind: top?.matchKind || null, alternatives: rows.slice(1, 4).map((x) => x.slug) });
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(tally, "of", out.length, "ingredient rows");
  console.log("\nMISSES / FUZZY:");
  for (const o of out.filter((o) => o.tier !== "hit")) console.log(o.tier.padEnd(6), `"${o.canonical}"`.padEnd(40), "←", o.printed.slice(0, 50).padEnd(52), "→", o.slug, o.alternatives.join(","));
  process.exit(0);
})();
