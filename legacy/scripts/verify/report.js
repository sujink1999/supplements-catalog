#!/usr/bin/env node
// Build report.md from extracted + resolved for human/agent review.
const fs = require("fs");
const path = require("path");
const V = path.join(__dirname, "../../../e2e/out/products/verify");
const ex = fs.readdirSync(path.join(V, "extracted")).map((f) => JSON.parse(fs.readFileSync(path.join(V, "extracted", f))));
const resolved = fs.existsSync(path.join(V, "resolved.json")) ? JSON.parse(fs.readFileSync(path.join(V, "resolved.json"))) : [];
const slugOf = (title, printed) => resolved.find((r) => r.product === title && r.printed === printed);
let md = `# Verify pass report (${new Date().toISOString().slice(0, 10)})\n\n${ex.length} products. Model: ${ex[0]?.model}. Tokens: in ${ex.reduce((a, r) => a + r.usage.prompt_tokens, 0)} out ${ex.reduce((a, r) => a + r.usage.completion_tokens, 0)}.\n\n`;
const byKind = {}; for (const r of ex) byKind[r.facts.kind] = (byKind[r.facts.kind] || 0) + 1;
md += `kinds: ${JSON.stringify(byKind)} · avg confidence ${(ex.reduce((a, r) => a + r.facts.confidence, 0) / ex.length).toFixed(2)}\n\n`;
for (const r of ex) {
  const f = r.facts;
  md += `## ${r.title}\n- ${r.url}\n- sampled as **${r.sampleClass}** · kind **${f.kind}** · confidence ${f.confidence} · serving: ${f.servingSize} · servings/container: ${f.servingsPerContainer}\n- label image: ${f.labelImageIndex == null ? "none" : r.imagesSent[f.labelImageIndex]}\n`;
  if (f.ingredients.length) {
    md += `\n| printed | canonical | amount | basis | slug | tier |\n|---|---|---|---|---|---|\n`;
    for (const i of f.ingredients) { const s = slugOf(r.title, i.printedName); md += `| ${i.printedName} | ${i.canonical} | ${i.amount ?? "?"} ${i.unit ?? ""}${i.isPartOfBlend ? " (blend)" : ""} | ${i.amountBasis} | ${s?.slug ?? ""} | ${s?.tier ?? ""} |\n`; }
  }
  if (f.notes) md += `\n> ${f.notes}\n`;
  md += "\n";
}
fs.writeFileSync(path.join(V, "report.md"), md);
console.log("→", path.join(V, "report.md"));
