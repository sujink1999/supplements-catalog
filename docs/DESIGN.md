# supplements-catalog — design (2026-09-27)

Standalone Node repo. Builds a catalog of buyable Indian supplement products (ingredients with
per-serving amounts, price, buy URL, images, certifications, pack marks, allergens) so an LLM in
os-backend can recommend products. Nothing here imports os-backend code. `data/` is gitignored
and holds paid LLM output: never delete it, copy before any destructive move.

Read first: `docs/research/01-history-issues.md` (59 problems and the lessons), `02-pipeline-map.md`
(legacy scripts, verbatim prompts, data contracts), `03-data-inventory.md` (what the data looks
like). Legacy code is in `legacy/scripts/`, legacy data in `data/legacy/` (2,771 products, 54 brands).

## Decisions (owner's, do not relitigate)
- One extraction read per product, not three. Errors are caught by code sanity rules plus a cheap
  text-only check; only flagged products get a high-reasoning re-read. Never have a model grade
  another model's read against the images (it hallucinated faults).
- Extraction returns everything in one record: classification, facts, pack marks, FSSAI licences,
  allergens, text claims. No separate certs/marks passes, no "wire it in later" step.
- Everything rule-based (gear/food/topical regex, no image, brand naming) runs BEFORE extraction.
  Only bundle/multipack rejection needs the classify call.
- Photographed pack wins over a flat spec graphic on conflict (verified by eye on Wellbeing Nutrition).
  Percentages stay as printed (`7 %`), never converted. Prompts from legacy `verify/extract2.js`,
  `marks.js`, `certs_llm.js` are hard-won: carry their rules verbatim, only merged.
- No merge stage. One row per listing (store+id or amazon.in+ASIN). Cross-source duplicates are
  linked later in the DB.
- Supplement scope: dosed protein bars in (`formFactor: "bar"`, `isFoodForm: true`); energy/snack/
  millet bars, food, gear, topicals out. Ayurvedic liquids taken as a measured dose are in.
  Singles only: bundles and multipacks rejected, value packs kept, "pack of 30 sachets" is a single.
- Models: default `gpt-6-luna` ($0.10/$0.50 per Mtok), high-effort re-read via `/v1/responses`
  with `text.format.json_schema` (chat completions rejects reasoning_effort with tools). Label
  images at `?width=1600` (already the 2,500-patch cap). Every LLM call is written to a cost
  ledger `data/ledger.jsonl` (run id, stage, model, tokens, usd).
- Sync: pipeline never writes prod directly. `finalize` writes `data/snapshots/catalog-v<N>.json`
  plus `.sha256`; `import` upserts a snapshot into catalog tables, `--target dev` default,
  `--target prod` requires `--yes-prod`. Import never deletes rows.

## Layout
```
config/brands.json      one entry per brand: {brand, shopify?: domain, amazonBrand?: string, aliases[], subBrands[]}
config/rules.js         NON_SUPP / GEAR / FOOD / TOPICAL regexes (single copy), thresholds, image widths
lib/env.js openai.js apify.js keys.js units.js ledger.js store.js(per-key json dir helpers) verification.js
stages/fetch.js filter.js extract.js check.js finalize.js
bin/catalog.js          `catalog <stage> --brand <b>` and `catalog brand <b>` (all stages, dry-run cost estimate first, --max-usd cap)
schema/catalog.sql      supplement_products, product_ingredients, product_offers (+ import job in stages/import.js)
viewer/                 static html over a snapshot
data/                   raw/<source>/<brand>.json, extract/<key>.json + .grid.jpg, checks/<key>.json, snapshots/
```
Every stage is keyed per product, skips work already on disk unless `--force`, and is safe to
re-run. `fetch` re-runs diff against the previous pull (delisted, stock, price changes).

## Record (finalize output row, one per listing)
Same fields as legacy `bulk/clean.json` row (see 02-pipeline-map §3) with these changes:
`source` always set (`shopify`|`amazon`); `key` = `<store>__<id>` or `amazon.in__<asin>`;
`ingredients[]` rows carry `amount, unit, role, canonical, printedName, amountBasis, isPartOfBlend,
blendName, source, flagged?`; `checks: {rules:[...], textCheck:{...}|null, reread:bool}` replaces
`agreement`; `packMarks`, `claims`, `allergens`, `fssaiLicences` come straight from extraction;
`schemaVersion` integer; `extractedAt`, `model`, `runId`.
