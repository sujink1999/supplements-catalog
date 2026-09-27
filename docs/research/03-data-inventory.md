# Supplement-catalog pipeline data inventory
`.../phase-2/scripts/e2e/out/products/` — generated, gitignored, paid LLM output. Read-only pass, nothing modified.

## 1. Directory tree, counts, sizes

```
products/                          2 top-level files: catalog.json (29M, 2771 rows), merge_report.json (77B)
  bulk/          28,825 files, 2.0G   (Shopify-store pipeline)
    clean.json          24M   list, 2374 rows   <- SINGLE BIG JSON (final clean output)
    rejects.json       189K   list, 1477 rows   <- SINGLE BIG JSON
    extracted/        6,868 files, 581M   per-product (.json + .grid.jpg pairs)
    read2/            6,645 files, 568M   per-product
    recheck/            646 files,  70M   per-product (small subset re-read)
    read3/            8,221 files, 679M   per-product (largest pass, superset)
    effort_high/       1,046 files, 116M  per-product (small "hard" subset)
    certs_judged/      1,122 files, 4.4M  per-product, JSON only (certification judging pass)
    marks/             2,371 files, 9.3M  per-product, JSON only
    review2/           1,894 files, 7.5M  per-product, JSON only
  amazon/         2,136 files, 180M   (Amazon pipeline)
    clean.json         3.7M   list, 397 rows    <- SINGLE BIG JSON
    rejects.json         57K   list, 261 rows   <- SINGLE BIG JSON
    extracted/         1,333 files, 85M   per-product (.json + .grid.jpg)
    fill/                263 files, 5.9M  per-product, JSON only
    fill_extracted/      489 files, 40M   per-product (.json + .grid.jpg)
    _test_out/             12 files, 852K  per-product, small test dump
  ab/             80 files, 8.1M    (A/B image-quality experiment)
    luna6/, sol/          40 files each, 4.1M each — same 20 product keys, two `.grid.jpg` variants each
  shopify/        34 files, 20M     raw per-store scrape dumps (one big JSON array per store) + manifest.json
```

`bulk/clean.json` + `amazon/clean.json` = 2374 + 397 = **2771**, exactly matching top-level `catalog.json` (2771). `merge_report.json` confirms: `{"matched":0,"shopifyOnly":2374,"amazonOnly":397,"pairs":[]}` — catalog.json is a straight concat, no Shopify/Amazon product matching has actually happened yet despite the merge step existing.

Per-dir shape: **single big JSON** = `bulk/clean.json`, `bulk/rejects.json`, `amazon/clean.json`, `amazon/rejects.json`, `catalog.json`, `merge_report.json`, each `shopify/<store>.json`. **Per-product (one file per key)** = everything else (`extracted`, `read2`, `recheck`, `read3`, `effort_high`, `certs_judged`, `marks`, `review2` under `bulk/`; `extracted`, `fill`, `fill_extracted`, `_test_out` under `amazon/`; both `ab/` dirs).

## 2. Key naming

- **Shopify-derived dirs** (`bulk/*`, `shopify/manifest.json` implicitly, `ab/*`): `<store-domain>__<numeric-shopify-id>`, e.g. `aceblend.com__7839305269506`.
- **Amazon `clean.json`/`extracted`/`_test_out`**: `amazon.in__<ASIN>`, e.g. `amazon.in__B00KDFRUGY`.
- **Amazon `fill/` and `fill_extracted/`**: inconsistent — filenames use the **Shopify-style key format** (`aceblend.com__8058774552834.json`, or in `fill_extracted` a 4-part `amazon.in__<sourcestore>__<sourceid>__<ASIN>.grid.jpg`), not `amazon.in__<ASIN>`. This means these two dirs cannot be matched against `amazon/clean.json` keys directly — confirmed: 0 of 397 clean-amazon keys are found as-is in `fill` or `fill_extracted` (see §6).
- `shopify/*.json` files are named by bare store domain (`superyou.in.json`), no per-product key at that level (they're raw arrays with `handle`/`id` fields inside).

## 3. clean.json field/value profile (bulk n=2374, amazon n=397, combined n=2771)

Row counts: bulk 2374, amazon 397, no duplicate `key` in either file or in combined/catalog (0 dup keys everywhere).

**Field fill-rates** (bulk / amazon, key ones):
- Always 100%: key, store, id, url, title, brand, brandRaw, productName, pack, currency, imageUrl, isFoodForm, confidence, verification, notes, extractedAt, model, certificationsRead.
- productType: 61.3% / 46.6%. formFactor: 97.9% / 99.7%. servingSize: 90.5% / 91.2%. servingsPerContainer: 81.3% / 85.1%. netQuantity: 65.7% / 94.7%. doseDirections: 75.7% / 88.2%.
- priceMin/priceMax: 90.5% (bulk) / 96.2% (amazon); combined price fill (priceMin or price) **91.3%**.
- currency 100%, url 100% (both).
- rating/reviewCount: 10.9% (bulk — comes only from `amazonOffer` cross-link) / 91.9% (amazon, native). Combined **22.5%**.
- allergens: 75.3% (bulk) / 96.5% (amazon) → combined **78.3%**.
- fssaiLicences: 31.3% (bulk) / 49.9% (amazon) → combined **33.9%**.
- ingredients list present: 95.8% (bulk) / 99.2% (amazon).
- images present (imageUrl/labelImages/images, any): **100%** combined.
- Amazon-only fields (not in bulk schema at all): source, asin, listPrice, inStock, ingredientsDeclared, starsBreakdown, reviewsLink, bestsellerRank, monthlyPurchaseVolume, seller, dietType, countryOfOrigin. Bulk-only fields: priceSource, amazonOffer, packDietMarks-adjacent fields present in both actually — biggest bulk-only field is `netQuantityNote` (7.6% fill) and `factsSource`/`factsSourceUrl`/`factsLabelImages`/`descriptionText`.
- No plain `price` field exists anywhere — only `priceMin`/`priceMax`. No `fssaiLicenses` (American spelling) exists, only `fssaiLicences`.

**source**: only Amazon rows set it (`"amazon"` × 397); all 2374 bulk rows have `source: null` (the field simply isn't set by the Shopify pipeline).

**store** (top): amazon.in 397, purenutrition.in 295, healthyhey.com 260, inlifehealthcare.com 179, mycf.in 171, wellbeingnutrition.com 152, thehimalayanorganics.in 141, beastlife.in 110, cureveda.com 110, in.fastandup.com 106, naturyz.in 82, unived.com 82, miduty.in 80, zeroharm.in 74, cosmix.in 62, bigmusclesnutrition.com 56, neuherbs.com 54, oziva.in 54, nakpro.com 38, steadfastnutrition.in 38, maxprotein.in 35, originnutrition.in 32, aceblend.com 30, traya.health 27, setu.in 24, www.yogabars.in 24, superyou.in 19, decodeage.com 14, nveda.in 12, www.gynoveda.com 7, thestack.club 6 (31 stores total in clean output vs 33 scraped per `shopify/manifest.json` — `boldfit.com` and `thesirona.com` were scraped, 0 rows made it into clean.json for `thesirona.com`; `boldfit.com` also absent from clean brand list despite 591 raw products).

**brand** (top 60, combined): Pure Nutrition 295, HealthyHey Nutrition 250, INLIFE 179, Carbamide Forte 171, Wellbeing Nutrition 152, Vlado's Himalayan Organics 141, Beastlife 110, Cureveda 110, Fast&Up 102, Naturyz 82, Unived 78, ZeroHarm 72, Miduty 69, Cosmix 62, Neuherbs 54, OZiva 54, BigMuscles Nutrition 51, Nutrabay 41, HK Vitals 39, Nakpro Nutrition 38, Steadfast Nutrition 38, MuscleBlaze 38, Kapiva 37, Max Protein 35, Nature's Velvet 34, Origin Nutrition 32, Ace Blend 30, Autoimmunity Care 28, Traya 27, Bhumija Lifesciences 25, Setu Nutrition 24, Yoga Bar 24, TrueBasics 24, Plix 22, Avvatar 21, Rasayanam 20, SuperYou 19, Boldfit 18, The Whole Truth 15, Decode Age 14, Nveda 12, PalakNots 11, Swisse 11, HealthyHey Sports 10, Man Matters 10, Be Bodywise 8, Gynoveda 7, The Stack Club 6, BM Wellness 5, Be Wellness 5, Chicnutrix 4, Ovegha 4, GainWell 2, HealthKart 1. (52 distinct brands total.)

**formFactor**: capsule 815, powder 709, tablet 510, sachet 166, effervescent 123, liquid 110, other 92, softgel 73, gummy 60, null 52, bar 28, strip 19, stick 5, pouch 2, oil 1, resin 1, mint 1, chewable 1, "capsule and powder" 1, whole 1, flake 1.

**verification**: label_read 2427 (87.6%), unverified_no_label 130, unverified_title_only 104, unverified_low_confidence 91, unverified_low_res 19.

**confidence**: continuous float mostly 0.8-0.99 (mode 0.91 ×336, 0.94 ×283, 0.96 ×234...); a distinct low tail exists (0.35 ×65, 0.2 ×41, 0.3 ×35, 0.1 ×21, 0.25 ×23) — bimodal, worth checking those ~185 low-confidence rows separately.

**isFoodForm**: False 2743, True 28 (1.0%) — all bars/food-form items are a small slice.

**certificationsRead** (dict of `{text, pack}` bools): `{text:False,pack:True}` 1338, `{text:True,pack:True}` 832, `{text:False,pack:False}` 601, `{text:True,pack:False}` 0 (never occurs — text-cert-read implies pack-cert-read was also attempted).

**Ingredient-level (46,607 ingredient rows across all 2771 products):**
- `agreement`: "2/2" 27,010 (58%), null 9,997 (21%, mostly Amazon rows which don't populate this), "1/1" 8,856 (19%), "pack" 744 (1.6% — resolved from pack image only, disagreement source).
- `unit` (top 30): mg 14,724, g 14,375, null 11,180 (24%, macro/other rows with no unit), mcg 2,493, kcal 1,711, % 537, "billion CFU" 396, "Kcal" 201 (inconsistent casing vs "kcal"), IU 196, "g/100g protein" 162, gm 77 (vs "g" — inconsistent), "million CFU" 68, "g per 100 g" 43, ml 38, "g/100 g protein" 36 (near-dup of the no-space variant), "g per 30 g" 27, µg 26, "q.s." 22, "I.U." 21 (vs "IU" — inconsistent), "g/100 g amino acid" 19, "g/100 g powder" 18, "g per 100 g powder" 18, "mcg DFE" 18, "g/100 g" 17, CFU 17, "Q.S." 11 (case dup of q.s.), "billion CFU/g" 9, HUT 8, "% per 100g" 7, "g per 100 ml" 7. Unit strings are not normalized — "kcal"/"Kcal", "g"/"gm", "IU"/"I.U.", "q.s."/"Q.S." all coexist.
- `packOverridden`: 259 products have ≥1 ingredient with a pack-vs-text disagreement flag.
- `amountUnverified`: field does not appear set true on any row (0 products) — either unused or always false in this run.

**Other fill rates** (combined 2771): price (priceMin/price) 91.3%, currency 100%, url 100%, rating 22.5%, reviewCount 22.5%, servingSize 90.6%, servingsPerContainer 81.8%, allergens 78.3%, fssaiLicences 33.9%. Images: 100% of rows have at least one image URL.

## 4. Example rows (full, image lists truncated to 2)

**Shopify example** — `aceblend.com__7839305269506` (has label_read + packOverridden): full macro/ingredient block, note the `packOverridden: ["113.21 kcal", "120.57 kcal"]` array on the Energy row showing pack-vs-text-vs-other-pack disagreement.

**Amazon example** — `amazon.in__B00KDFRUGY` (MuscleBlaze MB-Vite Multivitamin): has amazon-only fields (asin, listPrice, inStock, variants keyed by ASIN).

**Bar / isFoodForm example** — `maxprotein.in__5977144000666` (Max Protein Daily Variety Bars): `isFoodForm: true`, `verification: "unverified_no_label"`, `confidence: 0.36`, only 2 ingredient rows (protein, dietary fibre), null price/servingSize — a genuinely thin record because it's a multi-variant "variety pack" with no single label.

(Full JSON for all three was printed during the pass; truncated here to key differentiating fields per your 6-line example convention — ask if you want the raw pretty-printed blocks re-emitted.)

## 5. rejects.json reason distribution

- `bulk/rejects.json` (1477 rows): not_supplement 924 (62.6%), bundle 337 (22.8%), multipack 143 (9.7%), no_actives 57 (3.9%), topical 16 (1.1%).
- `amazon/rejects.json` (261 rows): not_supplement 97 (37.2%), bundle 87 (33.3%), multipack 77 (29.5%).

## 6. Per-product dir coverage vs clean.json (what still needs an LLM pass)

Bulk clean.json has 2374 distinct keys.
- `read3`: **0 missing** — full superset (4111 keys total, covers every clean product plus extras).
- `certs_judged`: **1542 missing** (65% of clean products never had certs judged). Top brands missing: Pure Nutrition 295, Carbamide Forte 148, Wellbeing Nutrition 111, Beastlife 99, Cureveda 88, INLIFE 78, Unived 69, ZeroHarm 68, Cosmix 59, Fast&Up 55, Miduty 54, Vlado's Himalayan Organics 40, Neuherbs 39, Steadfast Nutrition 36, Max Protein 35, Naturyz 33, Traya 27, HealthyHey Nutrition 25, Setu Nutrition 24, Yoga Bar 24.
- `marks`: **587 missing** (25%). Top brands: Pure Nutrition 295 (i.e. ALL of Pure Nutrition is missing marks), Max Protein 35, Beastlife 34, Cureveda 33, Traya 27, Yoga Bar 24, SuperYou 19, Wellbeing Nutrition 17, Carbamide Forte 16, Fast&Up 13, Nveda 12, ZeroHarm 8, Vlado's Himalayan Organics 8, Gynoveda 7, BigMuscles Nutrition 6, Setu Nutrition 5, OZiva 4, Decode Age 4, Cosmix 3, Neuherbs 3.
- Other bulk dirs vs clean keys: `extracted` missing 424, `read2` missing 506, `recheck` missing 2085 (it's a small targeted subset, 323 keys), `effort_high` missing 1943 (small targeted subset, 523 keys), `review2` missing 681.
- **Pure Nutrition (295 products, the single largest brand) is entirely absent from both `certs_judged` and `marks`** — the biggest concrete gap.

Amazon clean.json has 397 distinct keys.
- `extracted`: 0 missing (667 keys, full superset).
- `fill` / `fill_extracted`: appear to be "397 missing" but this is a **key-format mismatch, not missing data** — these two dirs use Shopify-style keys (`<store>__<id>`) or a 4-part cross-reference key, not `amazon.in__<ASIN>`, so a direct set-diff against amazon clean keys is meaningless as-is (see §2). Needs a proper join key before this gap can be measured.
- `_test_out`: only 12 files / 6 products, clearly a small dev smoke-test dump, not part of the real pipeline coverage.

## 7. Cost/usage ledgers, logs, manifests

No `*.log`, `*cost*`, or `*usage*` files exist anywhere under `products/`. The only manifest is `shopify/manifest.json`: per-store scrape counts + `fetchedAt` timestamps for 33 stores scraped 2026-09-27 15:01 UTC (product counts range from 591 for boldfit.com down to 7 for thestack.club/melblok.com). No token/cost accounting for the LLM extraction passes exists anywhere in this tree — that ledger, if it exists, lives elsewhere.

Notable manifest vs clean.json mismatch: `boldfit.com` (591 scraped) and `thesirona.com` (151 scraped) both appear in `shopify/manifest.json` but **zero rows from either survive into `bulk/clean.json`** — either 100% rejected or never processed past the raw scrape. Worth checking before treating "31 stores in clean.json" as the full universe.

## 8. Mechanical data-quality flags

- **Duplicate keys**: none, in any file (clean.json ×2, catalog.json, rejects.json all checked).
- **Zero-ingredient but verification=label_read**: none (0 rows) — good, that particular inconsistency doesn't occur.
- **Absurd/suspicious ingredient amounts** (12 rows flagged, amount <0 or >100,000):
  - `thehimalayanorganics.in__6618163183775`: Bromelain and Papain both listed as 125,000 FCCPU — plausible unit (FCCPU is a real enzyme-activity unit, large numbers normal) but flagged for manual eyeballing.
  - `wellbeingnutrition.com__7359303876688`: Lactobacillus acidophilus / Bifidobacterium longum at 28,000,000,000 CFU — this is 28B CFU restated as raw CFU (the `printedName` literally says "(28B CFU/serving)"), so the `amount`/`unit` pair (28000000000 / "CFU") duplicates info better expressed as the "billion CFU" unit seen elsewhere — an inconsistent-unit-choice bug, not a bad read.
  - `www.yogabars.in__8627961266348`: probiotic blend at 1,000,000,000 CFU — same pattern.
  - `amazon.in__B09M7B4HQX`: Erandmool at 177,770 mg (≈178g) — implausible for a single ingredient in a supplement serving, likely an OCR/decimal error.
  - `amazon.in__B0D63J41SS` and `amazon.in__B0F8N6JYF3`: Protease at 150,000 HUT — plausible enzyme unit, flag only.
  - `amazon.in__B07XQB87RF`, `amazon.in__B09GG47TC9`, `amazon.in__B0CCV5T996`: Trans Fat / Cholesterol as small **negative** values (-0.003 g, -0.03 mg, -0.004 g) — these are "< 0.005g" style label roundings misread as negative; genuine bug, 3 occurrences.
- **Prices of 0**: none found.
- **Non-https URLs** (url, imageUrl, labelImages): none found — all URLs are https.
- **Real gap, not mechanical but load-bearing**: `merge_report.json` shows 0 Shopify↔Amazon product matches attempted (`pairs: []`) despite both pipelines covering overlapping brands — cross-referencing hasn't run yet.
