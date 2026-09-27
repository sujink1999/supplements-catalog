# supplements-catalog

Builds a catalog of buyable Indian supplement products — ingredients with per-serving amounts,
price, buy URL, images, certifications, pack marks, allergens — so an LLM in os-backend can
recommend products. Nothing here imports os-backend code, and no stage touches a database.

The design and the owner's decisions are in `docs/DESIGN.md`. Read it before changing a stage.

## Run one brand end to end

```bash
cp .env.example .env            # fill in OPENAI_API_KEY (and APIFY_TOKEN for Amazon brands)
npm install

node bin/catalog.js brands                            # what config/brands.json knows
node bin/catalog.js brand "Ace Blend" --dry-run        # cost estimate, no calls
node bin/catalog.js brand "Ace Blend" --max-usd 0.50   # fetch -> filter -> extract -> check -> finalize
node bin/catalog.js ledger                            # what has been spent, per stage
```

Or one stage at a time — every stage is keyed per product, skips work already on disk, and is
safe to re-run:

```bash
node bin/catalog.js fetch    --brand "Ace Blend"
node bin/catalog.js filter   --brand "Ace Blend"
node bin/catalog.js extract  --brand "Ace Blend" --conc 6 --limit 5
node bin/catalog.js check    --brand "Ace Blend"
node bin/catalog.js finalize                          # snapshot over every extracted brand
```

Flags: `--source shopify|amazon` · `--force` (re-do work already on disk; the previous record is
kept as `.prev.json`) · `--conc N` · `--limit N` · `--only key,key` · `--effort none|low|medium|high`
· `--model <name>` · `--keyword` (Amazon: search the phrase instead of the brand facet) ·
`--max-usd N` · `--no-text-check` · `--no-reread`.

A brand that is not in `config/brands.json` is an error, never a guess. Add it there first.

## Stages

| stage | does | reads | writes |
|---|---|---|---|
| `fetch` | Shopify `/products.json` paginated, or Apify `junglee/amazon-crawler` over a brand-facet search (detached + polled) | config/brands.json | `data/raw/<source>/<brand>.json`, `.diff.json` (new / delisted / price / stock), `.manifest.json` |
| `filter` | all the rule-based work, before any paid call: non-supplement, gear, food, topical, off-brand, no-image, duplicate; assigns the canonical brand | `data/raw/...` | `data/filtered/<brand>.json`, `.dropped.json` |
| `extract` | two calls per product: (1) contact sheet of every photo + title/variants + a claim-trigger excerpt → classify, pick label tiles, judge text claims; (2) up to 4 label tiles at width 1600, pack photos first → facts panel + pack marks | `data/filtered/...` | `data/extract/<key>.json` + `<key>.grid.jpg` |
| `check` | code rules over the record, then an optional text-only model pass (no images); anything flagged is re-extracted at `--effort high` | `data/extract/...` | `data/checks/<key>.json`, a replaced `data/extract/<key>.json` with `.prev.json` beside it |
| `finalize` | business-rule rejection, brand naming, `splitNetQty`, verification tier, dedupe → one snapshot | everything above | `data/snapshots/catalog-v<N>.json` + `.sha256`, `rejects-v<N>.json` |

Only bundle/multipack rejection needs the model, which is why it lives in `finalize` and not in
`filter`.

## Data layout

```
data/                     gitignored; holds paid LLM output. NEVER delete anything here.
  raw/<source>/<brand>.json  .diff.json  .manifest.json
  filtered/<brand>.json      .dropped.json
  extract/<key>.json         <key>.grid.jpg   (+ .prev.json after a re-read)
  checks/<key>.json
  snapshots/catalog-v<N>.json  .sha256  rejects-v<N>.json
  ledger.jsonl               one line per paid call: run id, stage, model, tokens, usd
  legacy/                    the 2,771-row phase-2 catalog, input to bin/import-legacy.js
```

`key` is `<store>__<id>` for Shopify and `amazon.in__<ASIN>` for Amazon. One row per listing:
there is no merge stage, and cross-source duplicates are linked later in the DB.

## Snapshot v1 without re-extracting

```bash
node bin/import-legacy.js     # data/legacy/catalog.json -> data/snapshots/catalog-v1.json
```

2,771 rows, 54 brands. The legacy three-read vote has no equivalent here (this pipeline reads
once and checks with code), so an imported row gets `checks.rules: []` and keeps the old
`agreement` and `packOverridden` under `ingredients[].legacy`. Everything else legacy-only sits
in a product-level `legacy` object rather than being dropped.

## Cost model

`--dry-run` multiplies the product count by averages measured from the legacy runs:

| item | per product | measured from |
|---|---|---|
| extract (2 calls) | **$0.0023** | first bulk run: 3,252 Shopify rows for $7.62. The 45-item verify pass agrees: $0.10 / 45 = $0.0022 |
| text check | **$0.00025** | no legacy figure for exactly this call; derived from ~1.5k input + ~200 output tokens at `gpt-6-luna` $0.10/$0.50 per Mtok |
| high-effort re-read | **$0.00347** | high-effort tiebreak: $1.354 over 390 products |
| share flagged for re-read | **15%** | 390 disputed of 2,771 |
| Apify fetch (Amazon only) | **$0.004** | `junglee/amazon-crawler`, PAY_PER_EVENT, with product details |

So a Shopify brand costs about **$0.0031 per product** all in; an Amazon brand adds the Apify
line. Every call is appended to `data/ledger.jsonl`, `catalog ledger` sums it, and `--max-usd`
aborts the run rather than reporting an overshoot afterwards. Spend is attributed to a run id,
not a calendar day.

## Lessons baked in

`docs/research/01-history-issues.md` is a table of 59 real problems. The ones that shaped code
here, with where they live:

- **The photographed pack beats a flat spec graphic.** A brand's published spec graphic genuinely
  disagrees with the pack it ships (issue 59). `labelTileKinds` classifies each tile, pack photos
  are ordered first (`stages/extract.js` `orderLabelTiles`), and the prompt says so verbatim.
- **Never have a model grade another model's read.** A reviewer model invented 10 of 12 "major"
  faults because the schema forced it to produce one (issues 21, 27). `stages/check.js` uses code
  rules plus a text-only pass whose empty answer is the expected one, then re-measures
  independently at high effort.
- **Percentages stay as printed.** "Dates 7%" is `amount: 7, unit: "%"`, never converted
  (issue 49); `lib/units.js` returns `null` for a unit it cannot convert rather than guessing.
- **One key format.** Amazon keys existed in three shapes and a lookup on the wrong one silently
  lost 385 products (issue 44). `lib/keys.js` is the only key builder.
- **One copy of every regex and threshold.** `NON_SUPP` was duplicated three times with drift and
  the topical classifier three times more (§6 of the pipeline map). `config/rules.js` holds the
  union; the tests assert the clause that one legacy copy had lost.
- **One verification ladder, one unit table, one env loader, one Apify client.** Each was
  duplicated 2 to 8 times in legacy.
- **A missing brand is loud.** `brandOf`'s haystack fallback produced brand names made of product
  titles (issue 41); `lib/brands.js` returns `null` instead.
- **Give the model every photo cheaply first.** Three raw images missed the label panel; a
  contact sheet lets one call pick the right tiles (issue 8). 1600px is already at the model's
  patch budget, so there is nothing to gain from going higher (issue 48).
- **Size the output budget to the worst case.** Dense whey panels truncated the JSON at 3,000
  tokens (issue 14), so facts calls get 8,000.
- **`bar` must be in the enum description**, or bars silently classify as `other` (issue 53) —
  asserted in `test/prompts.test.js`.
- **Track spend from the provider, per run.** Self-tracking under-reported Apify by $2.28
  (issue 40); `lib/apify.js` logs Apify's own `usageTotalUsd`.
- **`data/` is never deleted.** A `git worktree remove --force` sweep destroyed $8 of extractions
  and a day of runtime (issue 22). A re-read keeps `.prev.json`; nothing overwrites paid output in
  place.

## Tests

```bash
npm test          # node --test, no network, fixtures cut from data/legacy/
```

Covers the drop rules, units, keys, `splitNetQty` against the real label strings that took four
iterations, the verification ladder, every check rule, the legacy import mapping, and the
prompt/schema assembly — including that each hard-won legacy rule sentence is still present
character for character.
