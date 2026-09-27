// Stage 4: catch the errors a single read makes, cheaply.
// (a) code rules over the record — free, deterministic, unit-tested;
// (b) an optional text-only model pass over the SAME record, no images. It never grades the
//     read against the label: a model asked to find faults in images it half-sees invented
//     10 of 12 "major" errors (issue 21/27). It only says which rows look internally wrong.
// (c) anything flagged is RE-EXTRACTED at --effort high. Verification by independent
//     measurement, not by critique.
// Out: data/checks/<key>.json; a re-read replaces data/extract/<key>.json and keeps .prev.json.
import path from "node:path";
import fs from "node:fs";
import { THRESHOLDS, MODELS, SCHEMA_VERSION } from "../config/rules.js";
import { normUnit, isBigUnit, isPer100Unit } from "../lib/units.js";
import { dir, readJson, writeJson, keyPath, keepPrevious } from "../lib/store.js";
import { slugify } from "../lib/brands.js";
import { callJson } from "../lib/openai.js";
import { pool } from "../lib/pool.js";
import { extractOne } from "./extract.js";

const rowsOf = (rec) => rec?.facts?.rows || [];
const find = (rows, re) => rows.filter((r) => re.test(`${r.canonical || ""} ${r.printedName || ""}`));

/**
 * Each rule is a pure function: (record) => finding[] where a finding is
 * { rule, severity: "reread"|"note", row: index|null, detail }.
 * "reread" means the record goes back for a high-effort read; "note" is recorded only.
 */
export const RULES = {
  negative_amount: (rec) =>
    rowsOf(rec)
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => typeof r.amount === "number" && r.amount < 0)
      .map(({ r, i }) => ({ rule: "negative_amount", severity: "reread", row: i, detail: `${r.printedName}: ${r.amount} ${r.unit}` })),

  // 125,000 FCCPU of bromelain is a normal label; 177,770 mg of one herb is an OCR error.
  absurd_amount: (rec) =>
    rowsOf(rec)
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => typeof r.amount === "number" && r.amount > THRESHOLDS.absurdAmount && !isBigUnit(r.unit, THRESHOLDS.bigUnits))
      .map(({ r, i }) => ({ rule: "absurd_amount", severity: "reread", row: i, detail: `${r.printedName}: ${r.amount} ${r.unit}` })),

  // "< 0.005 g" came back as -0.003 g three times: a printed bound is not a number we can state.
  lt_rounding: (rec) =>
    rowsOf(rec)
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => /[<＜]|less than/i.test(`${r.printedName || ""}`) && typeof r.amount === "number")
      .map(({ r, i }) => ({ rule: "lt_rounding", severity: "reread", row: i, detail: `printed as a bound but read as ${r.amount} ${r.unit}: ${r.printedName}` })),

  // Protein powders/creatine: the headline nutrient IS the active (issue 7).
  missing_headline_active: (rec) => {
    const title = `${rec.title || ""} ${rec.facts?.productName || ""}`;
    if (!/\b(whey|protein|creatine|gainer|isolate|casein)\b/i.test(title)) return [];
    const actives = rowsOf(rec).filter((r) => r.role === "active");
    if (find(actives, /protein|creatine/i).length) return [];
    return [{ rule: "missing_headline_active", severity: "reread", row: null, detail: `"${rec.title}" has no protein/creatine active row` }];
  },

  // A nutrition panel's energy line must roughly match 4/4/9 on its own macros.
  kcal_vs_macros: (rec) => {
    const rows = rowsOf(rec);
    const kcal = rows.find((r) => /^k?cal|energy/i.test(`${r.canonical || ""} ${r.printedName || ""}`) && /kcal/i.test(r.unit || "") && typeof r.amount === "number");
    if (!kcal) return [];
    const g = (re) => {
      const r = rows.find((x) => re.test(`${x.canonical || ""} ${x.printedName || ""}`) && normUnit(x.unit) === "g" && typeof x.amount === "number");
      return r ? r.amount : null;
    };
    const p = g(/\bprotein\b/i);
    const c = g(/carbohydrate|\bcarbs?\b/i);
    const f = g(/\b(total )?fat\b/i);
    if ([p, c, f].some((v) => v == null)) return [];
    const derived = 4 * p + 4 * c + 9 * f;
    if (!derived) return [];
    const off = Math.abs(derived - kcal.amount) / derived;
    if (off <= THRESHOLDS.kcalMacroTolerance) return [];
    return [{ rule: "kcal_vs_macros", severity: "reread", row: rows.indexOf(kcal), detail: `${kcal.amount} kcal printed vs ${derived.toFixed(0)} from ${p}P/${c}C/${f}F (${(off * 100).toFixed(0)}% off)` }];
  },

  // A per-100g unit on a row that should be per serving: the panel was read off the wrong column.
  per_100_unit: (rec) =>
    rowsOf(rec)
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.unit && isPer100Unit(r.unit))
      .map(({ r, i }) => ({ rule: "per_100_unit", severity: "reread", row: i, detail: `${r.printedName}: unit "${r.unit}" is not per serving` })),

  low_confidence: (rec) =>
    rec.facts && Number(rec.facts.confidence) < THRESHOLDS.lowConfidence
      ? [{ rule: "low_confidence", severity: "reread", row: null, detail: `confidence ${rec.facts.confidence}` }]
      : [],

  // No panel was found at all. A second read of the same images will not conjure one, so this
  // is recorded, never re-read: the fix is an Amazon photo set or nothing.
  no_label_tile: (rec) =>
    rec.facts && !(rec.labelImages || []).length ? [{ rule: "no_label_tile", severity: "note", row: null, detail: "no label tile was identified" }] : [],

  // "60 tablets" net quantity against servingsPerContainer 30 at 1 tablet a serving.
  servings_vs_net_quantity: (rec) => {
    const f = rec.facts;
    if (!f?.netQuantity || !f.servingsPerContainer || !f.servingSize) return [];
    const nq = /(\d+(?:\.\d+)?)\s*(kg|g|gm|ml|l|capsules?|caps?|tablets?|tabs?|softgels?|sachets?|sticks?|gummies|gummy|servings?)\b/i.exec(f.netQuantity);
    const ss = /(\d+(?:\.\d+)?)\s*(kg|g|gm|ml|l|capsules?|caps?|tablets?|tabs?|softgels?|sachets?|sticks?|gummies|gummy|scoops?)\b/i.exec(f.servingSize);
    if (!nq || !ss) return [];
    const unitClass = (u) => (/^(kg|g|gm)$/i.test(u) ? "mass" : /^(ml|l)$/i.test(u) ? "volume" : "count");
    if (unitClass(nq[2]) !== unitClass(ss[2])) return [];
    const scale = (u) => (/^(kg|l)$/i.test(u) ? 1000 : 1);
    const total = Number(nq[1]) * scale(nq[2]);
    const per = Number(ss[1]) * scale(ss[2]);
    if (!per) return [];
    const expected = total / per;
    const off = Math.abs(expected - f.servingsPerContainer) / Math.max(expected, 1);
    if (off <= 0.15) return [];
    return [
      {
        rule: "servings_vs_net_quantity",
        severity: "reread",
        row: null,
        detail: `servingsPerContainer ${f.servingsPerContainer} but ${f.netQuantity} / ${f.servingSize} ≈ ${expected.toFixed(1)}`,
      },
    ];
  },
};

/** All code findings for one extraction record. */
export function checkRules(rec) {
  if (!rec?.facts) return [];
  return Object.values(RULES).flatMap((fn) => fn(rec));
}

export const needsReread = (findings) => findings.some((f) => f.severity === "reread");

// ---------- optional text-only model check ----------
// The schema makes "nothing wrong" expressible and cheap, because forcing a finding is what
// manufactures one (issue 21).
const CHECK_SYS = `You are given one supplement record that was read off a product label: serving size, net quantity, and one row per printed line with an amount and unit. You do NOT get the label images, so never say a value disagrees with the label.
Judge only what the record says about itself. Report a row index when it is internally implausible: a dose orders of magnitude off for that ingredient, a unit that cannot belong to that line, a macro that contradicts the energy value, a group total repeated onto its members, a per-100g figure sitting on a per-serving row.
Returning an empty list is the right answer for most records. Never invent a finding to fill the list.`;

const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suspicious: {
      type: "array",
      description: "rows that look internally wrong; empty for most records",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { row: { type: "number", description: "index into rows" }, reason: { type: "string", description: "short, concrete" } },
        required: ["row", "reason"],
      },
    },
  },
  required: ["suspicious"],
};

const recordForCheck = (rec) => ({
  title: rec.title,
  productName: rec.facts.productName,
  formFactor: rec.facts.formFactor,
  servingSize: rec.facts.servingSize,
  servingsPerContainer: rec.facts.servingsPerContainer,
  netQuantity: rec.facts.netQuantity,
  rows: rowsOf(rec).map((r, i) => ({ i, role: r.role, printedName: r.printedName, amount: r.amount, unit: r.unit, isPartOfBlend: r.isPartOfBlend })),
});

export async function textCheck(rec, { model = MODELS.default, runId, budget }) {
  const { out, usage, usd } = await callJson({
    name: "suspicious_rows",
    system: CHECK_SYS,
    schema: CHECK_SCHEMA,
    content: [{ type: "text", text: JSON.stringify(recordForCheck(rec)) }],
    maxTokens: THRESHOLDS.checkMaxTokens,
    model,
    stage: "check",
    key: rec.key,
    runId,
    budget,
  });
  return { suspicious: out.suspicious || [], usage, usd };
}

// ---------- stage entry ----------
export async function run({ brand, force = false, conc = 4, limit = 0, only = [], textPass = true, reread = true, model = MODELS.default, runId, budget, log = console.log }) {
  const slug = slugify(brand);
  const input = readJson(path.join(dir("filtered"), `${slug}.json`), null);
  if (!input) throw new Error(`no filtered input at data/filtered/${slug}.json — run filter first`);
  const exDir = dir("extract");
  const ckDir = dir("checks");

  let keys = input.map((p) => p.key).filter((k) => fs.existsSync(keyPath(exDir, k)));
  if (only.length) keys = keys.filter((k) => only.includes(k));
  if (!force) keys = keys.filter((k) => !fs.existsSync(keyPath(ckDir, k)));
  if (limit) keys = keys.slice(0, limit);
  const byKey = new Map(input.map((p) => [p.key, p]));
  log(`${keys.length} records to check (text pass ${textPass ? "on" : "off"}, reread ${reread ? "on" : "off"})`);

  let flagged = 0;
  let rereads = 0;
  await pool(keys, conc, async (key) => {
    const rec = readJson(keyPath(exDir, key));
    const rules = checkRules(rec);
    let tc = null;
    // Nothing to check when the listing never produced facts, and nothing to pay for either.
    if (textPass && rec?.facts) tc = await textCheck(rec, { model, runId, budget });
    const flag = needsReread(rules) || (tc?.suspicious.length ?? 0) > 0;
    if (flag) flagged++;

    if (flag && reread && byKey.get(key)) {
      const file = keyPath(exDir, key);
      keepPrevious(file);
      const fresh = await extractOne(byKey.get(key), {
        model,
        effort: MODELS.rereadEffort,
        runId,
        budget,
        gridFile: keyPath(exDir, key, ".grid.jpg"),
      });
      writeJson(file, { ...fresh, reread: true });
      rereads++;
    }

    writeJson(keyPath(ckDir, key), {
      schemaVersion: SCHEMA_VERSION,
      key,
      checkedAt: new Date().toISOString(),
      rules,
      textCheck: tc ? { model, suspicious: tc.suspicious } : null,
      reread: flag && reread,
    });
  });
  log(`checked ${keys.length} | flagged ${flagged} | re-read at effort ${MODELS.rereadEffort}: ${rereads}`);
  return { checked: keys.length, flagged, rereads };
}
