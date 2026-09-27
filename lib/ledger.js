// Every paid call is appended to data/ledger.jsonl. Legacy tracked spend in each script's own
// console line and under-reported Apify by $2.28 because nothing summed across runs (issue 40).
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./env.js";
import { MODELS } from "../config/rules.js";

export const newRunId = () =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "") + "-" + Math.random().toString(36).slice(2, 6);

export const ledgerPath = () => path.join(dataDir(), "ledger.jsonl");

export function usdFor(model, tokensIn, tokensOut) {
  const price = MODELS.prices[model];
  if (!price) return null;
  return (tokensIn * price[0] + tokensOut * price[1]) / 1e6;
}

// One line per call. `usd` is null when the model's price is unknown, never silently zero.
export function record(entry) {
  const usd =
    entry.usd != null ? entry.usd : entry.model ? usdFor(entry.model, entry.tokensIn || 0, entry.tokensOut || 0) : null;
  const row = { at: new Date().toISOString(), ...entry, usd };
  const p = ledgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(row) + "\n");
  return row;
}

export function readLedger() {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function totals(rows) {
  const out = { calls: 0, tokensIn: 0, tokensOut: 0, usd: 0, unpriced: 0, byStage: {} };
  for (const r of rows) {
    out.calls++;
    out.tokensIn += r.tokensIn || 0;
    out.tokensOut += r.tokensOut || 0;
    if (r.usd == null) out.unpriced++;
    else out.usd += r.usd;
    const s = (out.byStage[r.stage] ||= { calls: 0, usd: 0 });
    s.calls++;
    s.usd += r.usd || 0;
  }
  return out;
}

export const totalsForRun = (runId) => totals(readLedger().filter((r) => r.runId === runId));

// A run-scoped spend guard. `--max-usd` aborts the run rather than discovering the overshoot
// afterwards, as happened at $7.62 against a ~$5 quote (issue 18).
export function budget(maxUsd) {
  let spent = 0;
  return {
    add(usd) {
      spent += usd || 0;
      if (maxUsd != null && spent > maxUsd) {
        const e = new Error(`--max-usd ${maxUsd} exceeded (spent $${spent.toFixed(3)}); aborting`);
        e.budgetExceeded = true;
        throw e;
      }
      return spent;
    },
    get spent() {
      return spent;
    },
  };
}
