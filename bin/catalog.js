#!/usr/bin/env node
// catalog <stage> --brand <b>     run one stage
// catalog brand <b>               fetch -> filter -> extract -> check -> finalize
// catalog brand <b> --dry-run     cost estimate only, no calls
// catalog ledger [--run <id>]     spend so far
// catalog brands                  what config/brands.json knows
import fs from "node:fs";
import path from "node:path";
import { loadEnv, dataDir } from "../lib/env.js";
import { COSTS, MODELS } from "../config/rules.js";
import { BRANDS, slugify, brandBySlug, shopifyStores } from "../lib/brands.js";
import { readJson, dir } from "../lib/store.js";
import * as ledger from "../lib/ledger.js";
import * as fetchStage from "../stages/fetch.js";
import * as filterStage from "../stages/filter.js";
import * as extractStage from "../stages/extract.js";
import * as checkStage from "../stages/check.js";
import * as finalizeStage from "../stages/finalize.js";

loadEnv();
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => (has(k) ? argv[argv.indexOf(k) + 1] : d);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !/^--(force|dry-run|keyword|no-text-check|no-reread)$/.test(argv[i - 1])));

const cmd = positional[0];
const brandArg = val("--brand", positional[1]);
const opts = {
  source: val("--source", null),
  force: has("--force"),
  conc: Number(val("--conc", 4)),
  limit: Number(val("--limit", 0)),
  only: (val("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean),
  effort: val("--effort", "none"),
  model: val("--model", MODELS.default),
  keyword: has("--keyword"),
  textPass: !has("--no-text-check"),
  reread: !has("--no-reread"),
  maxUsd: has("--max-usd") ? Number(val("--max-usd")) : null,
};

const usage = () => {
  console.log(`catalog <fetch|filter|extract|check|finalize> --brand <brand>
catalog brand <brand> [--dry-run] [--max-usd 2.50]
catalog ledger [--run <runId>]
catalog brands

flags: --source shopify|amazon  --force  --conc N  --limit N  --only key,key
       --effort none|low|medium|high  --model <name>  --keyword  --max-usd N
       --no-text-check  --no-reread`);
};

// Cost model. Per-product averages measured from the legacy runs:
//   extract  $0.0023  first bulk run, 3,252 Shopify rows for $7.62 (the 45-item verify pass
//                     agreed: $0.10 / 45 = $0.0022)
//   reread   $0.00347 high-effort tiebreak, $1.354 over 390 products
//   check    $0.00025 derived, ~1.5k in + 200 out at gpt-6-luna $0.10/$0.50 per Mtok
//   flagRate 0.15     390 disputed of 2,771 in the legacy catalog
//   apify    $0.004   junglee/amazon-crawler with product details
function estimate(slug) {
  const entry = brandBySlug(slug);
  const src = opts.source || (entry?.shopify ? "shopify" : "amazon");
  const filtered = readJson(path.join(dataDir(), "filtered", `${slug}.json`), null);
  const raw = readJson(path.join(dataDir(), "raw", src, `${slug}.json`), null);
  const n = filtered?.length ?? raw?.length ?? null;
  const basis = filtered ? "filtered listings" : raw ? "raw listings (pre-filter, so an over-estimate)" : null;
  const fetchUsd = src === "amazon" ? (n ?? 0) * COSTS.apifyPerProduct : 0;
  const perProduct = COSTS.extractPerProduct + (opts.textPass ? COSTS.checkPerProduct : 0) + (opts.reread ? COSTS.flagRate * COSTS.rereadPerProduct : 0);
  return { n, basis, src, fetchUsd, perProduct, total: n == null ? null : fetchUsd + n * perProduct };
}

function printEstimate(slug) {
  const e = estimate(slug);
  if (e.n == null) {
    console.log(`no pull on disk for ${slug}: run "catalog fetch --brand ${slug}" first, then --dry-run gives a real number.`);
    console.log(`per product: extract $${COSTS.extractPerProduct} + check $${COSTS.checkPerProduct} + ${COSTS.flagRate * 100}% x reread $${COSTS.rereadPerProduct} = $${e.perProduct.toFixed(5)}`);
    return e;
  }
  console.log(`${slug}: ${e.n} ${e.basis}`);
  if (e.fetchUsd) console.log(`  apify fetch   ${e.n} x $${COSTS.apifyPerProduct} = $${e.fetchUsd.toFixed(2)}`);
  console.log(`  extract       ${e.n} x $${COSTS.extractPerProduct} = $${(e.n * COSTS.extractPerProduct).toFixed(3)}`);
  if (opts.textPass) console.log(`  text check    ${e.n} x $${COSTS.checkPerProduct} = $${(e.n * COSTS.checkPerProduct).toFixed(3)}`);
  if (opts.reread) console.log(`  reread (${COSTS.flagRate * 100}%)  ${Math.round(e.n * COSTS.flagRate)} x $${COSTS.rereadPerProduct} = $${(e.n * COSTS.flagRate * COSTS.rereadPerProduct).toFixed(3)}`);
  console.log(`  estimated total $${e.total.toFixed(2)}`);
  return e;
}

function printRunSpend(runId) {
  const t = ledger.totalsForRun(runId);
  console.log(`\nrun ${runId}: ${t.calls} calls, tokens in ${t.tokensIn} out ${t.tokensOut}, $${t.usd.toFixed(4)}${t.unpriced ? ` (${t.unpriced} unpriced)` : ""}`);
  for (const [stage, s] of Object.entries(t.byStage)) console.log(`  ${String(stage).padEnd(10)} ${String(s.calls).padStart(5)} calls  $${s.usd.toFixed(4)}`);
}

(async () => {
  if (!cmd || has("--help") || has("-h")) return usage();

  if (cmd === "brands") {
    console.log(`${BRANDS.length} brands | ${shopifyStores().length} Shopify stores | ${BRANDS.filter((b) => b.amazonBrand).length} with an Amazon facet`);
    for (const b of BRANDS) {
      console.log(`  ${b.brand.padEnd(28)} ${(b.shopify || "").padEnd(26)} ${b.amazonBrand ? "amazon:" + b.amazonBrand : b.subBrandOnly ? "(sub-brand)" : ""}`);
    }
    return;
  }

  if (cmd === "ledger") {
    const runId = val("--run", null);
    const rows = runId ? ledger.readLedger().filter((r) => r.runId === runId) : ledger.readLedger();
    const t = ledger.totals(rows);
    console.log(`${t.calls} calls, tokens in ${t.tokensIn} out ${t.tokensOut}, $${t.usd.toFixed(4)}${t.unpriced ? ` (${t.unpriced} unpriced)` : ""}`);
    for (const [stage, s] of Object.entries(t.byStage)) console.log(`  ${String(stage).padEnd(10)} ${String(s.calls).padStart(6)} calls  $${s.usd.toFixed(4)}`);
    return;
  }

  if (cmd === "finalize") {
    finalizeStage.run({ brand: brandArg ? slugify(brandArg) : null });
    return;
  }

  if (!brandArg) {
    usage();
    process.exitCode = 1;
    return;
  }
  const slug = slugify(brandArg);
  if (!brandBySlug(slug)) throw new Error(`unknown brand "${brandArg}" — add it to config/brands.json (catalog brands lists them)`);

  if (has("--dry-run")) {
    printEstimate(slug);
    return;
  }

  const runId = ledger.newRunId();
  const budget = ledger.budget(opts.maxUsd);
  console.log(`run ${runId}${opts.maxUsd != null ? ` (cap $${opts.maxUsd})` : ""}`);

  const stages = {
    fetch: () => fetchStage.run({ brand: slug, source: opts.source, keyword: opts.keyword, max: opts.limit || undefined, runId, budget }),
    filter: () => filterStage.run({ brand: slug, source: opts.source }),
    extract: () => extractStage.run({ brand: slug, ...opts, runId, budget }),
    check: () => checkStage.run({ brand: slug, ...opts, runId, budget }),
  };

  try {
    if (cmd === "brand") {
      const e = printEstimate(slug);
      if (opts.maxUsd != null && e.total != null && e.total > opts.maxUsd) {
        console.log(`estimate $${e.total.toFixed(2)} already exceeds --max-usd ${opts.maxUsd}; nothing run.`);
        process.exitCode = 1;
        return;
      }
      await stages.fetch();
      stages.filter();
      await stages.extract();
      await stages.check();
      finalizeStage.run({ brand: slug });
    } else if (stages[cmd]) {
      await stages[cmd]();
    } else {
      usage();
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    if (e.budgetExceeded) console.log(`\nABORTED: ${e.message}`);
    else throw e;
    process.exitCode = 1;
  }
  if (fs.existsSync(ledger.ledgerPath())) printRunSpend(runId);
})();
