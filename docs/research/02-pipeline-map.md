# Supplement-catalog pipeline map (phase-2 worktree)

Root: `scripts/supplements/products/` (all paths below relative to it unless noted).
Output root: `scripts/e2e/out/products/` (gitignored, JSON only — this worktree may
never touch a database; `_parked/` holds the two scripts that do and are disabled).

## 1. Inventory

| file | lines | purpose | args/flags | env | external calls |
|---|---|---|---|---|---|
| `fetch_shopify.js` | 76 | Pull full catalogs from ~30 hardcoded Indian D2C Shopify stores via public `/products.json` | `[store ...]` positional override of `STORES` | none | `https://<store>/products.json` (no auth) |
| `bulk_input.js` | 26 | Build extraction input list from all fetched Shopify catalogs; drops non-supplements and no-image rows | none | none | none |
| `inspect.js` | 43 | Diagnostic: what fraction of fetched rows are supplements and whether dose is in title/body text vs needs label image | `[--list <store>]` | none | none |
| `certs.js` | 77 | Regex scrape of "claimed" certifications/testing from listing text (Shopify body + Amazon prepared) | none | none | none |
| `certs_llm.js` | 131 | LLM judgment pass turning regex candidate claims into judged, categorized claims (product vs ingredient level, testing vs purity) | `[--limit N] [--conc 8] [--force] [--only-file <f>]` | `OPENAI_API_KEY` | OpenAI chat.completions |
| `marks.js` | 86 | LLM reads certification/testing marks and allergen statements actually printed on pack photos | `[--limit N] [--conc 6] [--force] [--only-file <f>]` | `OPENAI_API_KEY` | OpenAI chat.completions |
| `marks_probe.js` | 79 | One-off A/B probe: full-res label tiles vs 320px contact sheet for reading marks | `[--n 20]` | `OPENAI_API_KEY` | OpenAI chat.completions |
| `adjudicate.js` | 74 | Majority-vote across up to 4 independent LLM reads of the same label (read3/extracted/read2 or recheck/effort_high) | none | none | none (pure JSON merge) |
| `clean.js` | 213 | Main cleaner: merges extracted facts + adjudication + Amazon-fill + certs/marks into final Shopify catalog rows; drops bundles/multipacks/non-supp/topicals; dedupes | none | none | none |
| `review.js` | 56 | Second-read QA pass on `clean.json` with a cheap vision model, flags amount/serving errors | `[--model gpt-5.4-mini] [--limit N] [--conc 4] [--force]` | `OPENAI_API_KEY` | OpenAI chat.completions |
| `fill_apply.js` | 34 | Turns Amazon re-extractions of Shopify products (with no usable own label) into a patch file `clean.js` applies | none | none | none |
| `merge.js` | 101 | Merges Shopify `clean.json` + Amazon `clean.json` into one `catalog.json`, matching by brand + token-overlap + dose fingerprint | none | none | none |
| `amazon_brand.js` | 143 | Pull one brand's listings from amazon.in via Apify `junglee/amazon-crawler`, paginated with an out-of-stock stop rule | `"<brand>" [--max 40] [--out <dir>] [--page 30] [--keyword]` | `APIFY_TOKEN` | Apify REST API |
| `amazon_prepare.js` | 84 | Filters raw Amazon brand pulls (drops off-brand/gear/food/topical/no-image/dup), builds `extract_input.json` | none | none | none |
| `amazon_fill.js` | 73 | For Shopify products with an unreadable label, searches amazon.in for the same product and stages it for re-extraction | `[--limit 5] [--per 4] [--verification <list>] [--conc 8]` | `APIFY_TOKEN` | Apify REST API |
| `amazon_price.js` | 68 | Finds a live Amazon price/rating/stock for products whose Shopify variants are all sold out | `[--limit N] [--per 3] [--conc 8]` | `APIFY_TOKEN` | Apify REST API |
| `amazon_clean.js` | 127 | Cleans Amazon extractions the same way as `clean.js`, carries Amazon-only fields (rating, review count, bestseller rank, legal ingredients declaration) | none | none | none |
| `verify/apify_probe.js` | 27 | One-off probe: confirm Apify junglee crawler returns INR price, ingredients box, rating fields | `["query"]` | `APIFY_TOKEN` | Apify REST API |
| `verify/sample.js` | 42 | Stratified sample (dose/ingWord/image/bundle buckets) of fetched products for the manual verify pass | none | none | none |
| `verify/extract.js` | 96 | (Superseded) single-call LLM extraction of supplement facts for sampled products | `[--model gpt-5.6-luna] [--limit N] [--force]` | `OPENAI_API_KEY` | OpenAI chat.completions |
| `verify/extract2.js` | 189 | Two-call extraction: classify+pick-label-tiles, then read facts off chosen tiles — this is the production extractor used by both bulk pipelines | `[--model gpt-6-luna] [--limit N] [--force] [--in <f>] [--out <f>] [--only <ids>] [--conc N] [--batch N] [--effort none\|low\|medium\|high]` | `OPENAI_API_KEY` | OpenAI chat.completions / responses; also fetches product images via `grid.js` |
| `verify/grid.js` | 38 | Builds a numbered contact-sheet JPEG from a product's images (sharp) | n/a (module, not CLI) | none | fetches each image URL |
| `verify/report.js` | 23 | Renders `extracted/` + `resolved.json` into a human-readable `report.md` | none | none | none |
| `brands.txt` | 37 | Candidate brand/domain list (mix of Shopify + non-Shopify) for `amazon_brand.js` targeting — not read programmatically by any script found | n/a | n/a | n/a |
| `_parked/README.md` | 11 | Explains why resolve.js/resolve2.js are disabled in this worktree | n/a | n/a | n/a |
| `_parked/resolve.js` | 41 | (Disabled — DB access) Resolves extracted ingredient names to `supp_ingredients` slugs via `textMatch`, single-call extraction era | n/a | `DATABASE_URL_V2`(implicit via `src/db`) | Postgres SELECT |
| `_parked/resolve2.js` | 69 | (Disabled — DB access) Same but for `extract2.js`'s active rows, with an LLM tie-break among textMatch candidates | n/a | DB + `OPENAI_API_KEY` | Postgres SELECT + OpenAI |

Note: `inspect.js`, `verify/sample.js`, `bulk_input.js` all hand-roll the same `NON_SUPP` regex slightly differently — see §6.

## 2. Stage graph (brand name → clean catalog JSON)

Two parallel source pipelines (Shopify, Amazon) that share the same extractor and merge at the end.

### Shopify pipeline
1. **Fetch** — `fetch_shopify.js` — in: hardcoded `STORES` list → out: `shopify/<store>.json`, `shopify/manifest.json`. Not resumable per-item (fetches all pages of a store each run); per-store try/catch so one bad store doesn't kill the run. No concurrency (stores fetched serially); 500ms sleep between paginated calls to one store. Free, no LLM. Error handling: non-2xx throws inside `fetchStore`, caught per store, recorded in manifest.
2. **Bulk input build** — `bulk_input.js` — in: `shopify/*.json` → out: `bulk/input.json`. Drops `NON_SUPP` regex hits and rows without images. Not incremental; full rebuild each run.
3. **Extraction (2-call)** — `verify/extract2.js` — in: `bulk/input.json` (or any `--in`) → out: `bulk/<dir>/<store>__<id>.json` + `.grid.jpg`. **Idempotent/resumable**: skips existing output files unless `--force`; `--only` re-targets specific ids. Cost driver: per product, 2 LLM calls (classify contact-sheet + facts on up to 4 chosen tiles); image fetch+resize cost per tile. Concurrency via `--conc` (simple work-queue `Promise.all`). Error handling: per-product try/catch, logs and continues. This one script produced multiple read generations by pointing `--out` at different directories: `extracted/` (read 1), `read2/`/`recheck/` (read 2), `effort_high/` (read 3, high-effort rerun on the subset that disagreed), `read3/` (the newest single read — supersedes `extracted/`).
4. **Adjudication** — `adjudicate.js` — in: `bulk/{read3,extracted,read2,recheck,effort_high}/*.json` → out: `bulk/adjudicated.json`. Majority vote (see §3 for merge rule); not itself LLM-calling, cheap and deterministic; naturally idempotent (pure function of inputs).
5. **Amazon fill patch** (cross-pipeline; needs Amazon fill extraction first, see below) — `fill_apply.js` — in: `amazon/fill_extracted/*.json` → out: `bulk/fill_patch.json`.
6. **Certs (regex)** — `certs.js` — in: `bulk/input.json`, `amazon/prepared.json` → out: `bulk/certs_patch.json`, `amazon/certs_patch.json`. No LLM, free.
7. **Certs (LLM judged)** — `certs_llm.js` — in: `bulk/input.json` + `amazon/prepared.json`, filtered by `catalog.json` membership if present → out: `bulk/certs_judged/<key>.json`. Idempotent per key (skip existing unless `--force`); concurrency via `--conc`; cost driver: one small call per listing (excerpted trigger-sentence text only, no images).
8. **Pack marks** — `marks.js` — in: `catalog.json` (post-merge!) filtered to items with `labelImages`/`imageUrl` → out: `bulk/marks/<key>.json`. Idempotent per key; concurrency via `--conc`; cost driver: 1-3 full-res images per call.
9. **Price patch** — `amazon_price.js` — in: `bulk/clean.json` rows with `priceMin == null` → out: `bulk/price_patch.json`. Cost driver: one Apify search run per product (12s poll loop), `--conc` limited.
10. **Clean** — `clean.js` — in: `bulk/input.json`, `bulk/adjudicated.json`, `bulk/fill_patch.json`, `bulk/certs_patch.json`, `bulk/certs_judged/*`, `bulk/marks/*`, `bulk/price_patch.json`, plus the raw `extracted/`+`read3/` extraction dirs → out: `bulk/clean.json`, `bulk/rejects.json`. Not incremental (full rebuild); dedupes on `store|brand|productName|formFactor` keeping highest confidence.
11. **Review (QA)** — `review.js` — in: `bulk/clean.json` → out: `bulk/review2/<key>.json`, observation-only, does not feed back into `clean.json` automatically.

### Amazon pipeline
1. **Fetch by brand** — `amazon_brand.js` — in: brand name arg → out: `amazon/<brand>.json`. Paginated Apify runs; stop condition `STOP_OOS = 0.34` (34% sold-out ratio) or no new ASINs. Cost driver: Apify pay-per-result, tracked via `usageTotalUsd`.
2. **Prepare** — `amazon_prepare.js` — in: all `amazon/*.json` brand pulls (excluding known derived filenames) → out: `amazon/prepared.json`, `amazon/dropped.json`, `amazon/extract_input.json`. Drops off-brand/gear/food/topical/no-image/dup by regex + alias table.
3. **Extraction** — `verify/extract2.js` again, pointed at `amazon/extract_input.json` → out: `amazon/extracted/<asin>.json` (same idempotent/resumable behavior as Shopify's use).
4. **Amazon fill loop** (feeds back into Shopify pipeline step 5): `amazon_fill.js` finds Amazon matches for weak-Shopify-label products → `amazon/fill_input.json`; `verify/extract2.js` extracts those → `amazon/fill_extracted/`; `fill_apply.js` turns that into `bulk/fill_patch.json`.
5. **Clean** — `amazon_clean.js` — in: `amazon/extracted/*`, `amazon/prepared.json`, `bulk/certs_judged/*`, `bulk/marks/*` (shared dirs, `amazon.in__<asin>` / `amazon__<asin>` keys) → out: `amazon/clean.json`, `amazon/rejects.json`.

### Merge
`merge.js` — in: `bulk/clean.json`, `amazon/clean.json` → out: `catalog.json`, `merge_report.json`. Matches Shopify rows to Amazon rows by brand index + Jaccard title-token overlap + active-ingredient dose fingerprint (`doseKey`), threshold `bestScore >= 0.62` (dose match floors score at 0.8). Not idempotent-marked but is a pure function of the two clean files (safe to rerun). No LLM, no external calls.

Certs-LLM and marks then run again against `catalog.json` (step 7/8 above) to cover the merged set including Amazon-only rows, producing the final enrichment layers consumed a second time implicitly (both cleaners already read `certs_judged`/`marks` before merge, but `marks.js` explicitly reads `catalog.json` so a full pass typically runs certs_llm/marks twice: once pre-merge, once post-merge, keyed so both work — see §6 duplication note).

## 3. Data contracts (verbatim field lists from code)

### Shopify raw product row (`fetch_shopify.js` output)
```
{ store, id, handle, url, title, vendor, productType, tags, bodyHtml,
  publishedAt, updatedAt, options: [name],
  variants: [{ id, title, sku, price, compareAtPrice, available, grams, url }],
  images: [{ src, alt, w, h }] }
```

### Bulk/Amazon extraction input row (`bulk_input.js` / `amazon_prepare.js` output, extract2.js input)
```
{ store, id, url, title, vendor, productType, tags, bodyHtml, variants: [{title, price}],
  images: [{src, w, h}] }   // Shopify keeps its full fetch shape plus `store` tag added by bulk_input.js
```
Amazon's `extract_input.json` / `fill_input.json` rows: `{store: "amazon.in", id: asin, url, title, vendor, productType, tags: [], bodyHtml, variants: [{title, price}], images: [{src,w,h}]}`.

### extract2.js result (`extracted2/<key>.json`, `read3/`, `effort_high/`, etc.)
```
{ store, id, url, title, sampleClass?, model, imageCount, tiles: [{index, src}],
  classify: {  // CLASSIFY_SCHEMA
    listing: "supplement"|"not_supplement",
    pack: "single"|"multipack"|"bundle"|"value_pack"|"n/a",
    unitsInContainer: number|null,
    bundleComponents: [string],
    labelTiles: [number], labelTileKinds: ["pack_photo"|"spec_graphic"],
    frontTile: number|null, reason: string
  },
  labelImages: [url], labelKinds: ["pack_photo"|"spec_graphic"],
  facts: null | {  // FACTS_SCHEMA
    brand, productName, formFactor: string|null,
    servingSize, servingsPerContainer, netQuantity, doseDirections,
    rows: [{ role: "active"|"macro"|"excipient", printedName, canonical,
      amount: number|null, unit: string|null, amountBasis: "elemental"|"compound"|"unknown",
      form, standardization, isPartOfBlend: bool, blendName, blendTotalMg,
      source: "label_image"|"description"|"title" }],
    confidence, notes,
    lowResLabel?: true   // added post-hoc when all label images < 800px wide
  },
  usage: {in, out}, ms }
```

### Adjudicated row (`adjudicated.json[key]` — array of rows)
Each row is a `facts.rows` entry (same shape as above) plus one of:
`agreement: "1/1"` (single read saw it) · `"2/2"` (two reads agreed) · `"2/3"` (majority of 3) ·
`"pack"` + `packOverridden: [otherReadStrings]` (read3/pack photo overrode disagreeing older reads) ·
`"none"` + `amount: null, amountUnverified: true, candidates: [strings]` (no two reads agreed).

### certs_judged row (`certs_judged/<key>.json`)
```
{ productTesting: [{ kind: <enum, 16 values>, programme: string|null, everyBatch: bool, quote: string }],
  purityClaims: [string],
  facilityOrLicence: [enum: fssai|ayush|gmp|cgmp|haccp|iso_9001|iso_22000|iso_17025|nabl_accredited_lab|us_fda_registered|usda_organic|india_organic|halal|kosher|other],
  dietFlags: [enum: vegan|vegetarian|gluten_free|sugar_free|non_gmo|dairy_free|lactose_free|soy_free|nut_free|palm_oil_free|halal|kosher|no_artificial_additives],
  ingredientLevel: [string],
  fssaiLicence: string|null }
```

### marks row (`bulk/marks/<key>.json`)
```
{ testingMarks: [{ mark, kind: <enum 9 values>, legible: bool }],
  certificationMarks: [{ mark, legible: bool }],
  dietMarks: [enum: vegetarian_green_dot|non_vegetarian_brown_dot|vegan|gluten_free|sugar_free|halal|kosher|non_gmo|organic],
  fssaiLicences: [{ number, role: marketed_by|manufactured_by|packed_by|imported_by|unknown }],
  allergens: { contains: [enum 11], mayContainTraces: [enum 11], freeFrom: [string], statement: string|null },
  otherPackMarks: [string], illegibleBadgeCount: number }
```

### Final clean.json row (Shopify, `clean.js`)
```
{ key, store, id, url, title, vendor, brand, brandRaw, productName,
  productType, tags,
  pack, formFactor, servingSize, servingsPerContainer, netQuantity, netQuantityNote, unitsInContainer,
  doseDirections,
  priceMin, priceMax, priceSource: "store"|"amazon"|null,
  amazonOffer: {asin,url,price,listPrice,inStock}|null,
  rating, reviewCount, reviewsSummary, currency: "INR",
  variants: [{id,title,price,url}],
  imageUrl, labelImages,
  isFoodForm: bool,
  ingredients: [rows...], confidence, verification: <one of the 5 tiers>, notes,
  claimedTesting, claimedPurity, claimedFacility, claimedDiet, ingredientLevelCertifications,
  packTestingMarks: [{mark,kind}], packCertificationMarks: [string], packDietMarks, allergens,
  fssaiLicences, illegibleBadges,
  certificationsRead: {text: bool, pack: bool},
  keywordClaims,
  factsSource: "amazon"|"store", factsSourceUrl, factsLabelImages,
  descriptionText, extractedAt, model,
  duplicateOf?: key   // present only on rows folded as duplicates, filtered before writing final clean.json
}
```
`verification` tiers (rank order in `merge.js`): `label_read`(3) > `unverified_low_res`/`unverified_low_confidence`(2) > `unverified_no_label`(1) > `unverified_title_only`(0).

### rejects.json row
```
{ key, reason: "not_supplement"|"bundle"|"multipack"|"no_facts"|"topical"|"no_actives", title }
```

### Amazon clean.json row (`amazon_clean.js`) — mostly overlaps Shopify's, plus Amazon-only fields
```
{ key: "amazon.in__<asin>", source: "amazon", store: "amazon.in", id, asin, url, title,
  brand, brandRaw, productName, productType, tags: [],
  pack, formFactor, servingSize, servingsPerContainer, netQuantity, unitsInContainer, doseDirections,
  priceMin, priceMax, listPrice, currency: "INR", inStock,
  variants: [{id,title,price,url}], imageUrl, labelImages, ingredients,
  ingredientsDeclared,   // Amazon legal declaration text, ingredient list w/ no amounts
  rating, reviewCount, starsBreakdown, reviewsSummary, reviewKeywords, reviewsLink,
  bestsellerRank, monthlyPurchaseVolume, seller, dietType, countryOfOrigin,
  claimedTesting, claimedPurity, claimedFacility, claimedDiet, ingredientLevelCertifications,
  packTestingMarks, packCertificationMarks, packDietMarks, allergens, fssaiLicences, illegibleBadges,
  certificationsRead, keywordClaims, isFoodForm, confidence, verification, notes,
  descriptionText, extractedAt, model, duplicateOf? }
```

### Amazon raw pull row (`amazon_brand.js` `norm()` output, before prepare/extraction)
```
{ asin, url, title, brand, seller, price, listPrice, currency:"INR", inStock,
  rating, reviewCount, starsBreakdown, reviewsSummary, reviewKeywords: [{name,sentiment}],
  reviewsLink, monthlyPurchaseVolume, bestsellerRank, breadCrumbs, images: [url],
  ingredientsText, doseDirections, safetyInfo, itemForm, unitCount, dietType,
  supplementType, countryOfOrigin, manufacturer, description, features, raw: <full Apify item> }
```

### catalog.json row (`merge.js`) — union shape
For matched pairs: spreads the "primary" side's clean.json row (winner by `verification` rank), then overrides:
```
{ ...primary, key: shopifyKey, sources: ["shopify","amazon"],
  offers: [offerOf(shopify), offerOf(amazon)],
  priceMin, priceMax, rating, reviewCount, reviewsSummary, reviewKeywords, starsBreakdown,
  reviewsLink, bestsellerRank, monthlyPurchaseVolume, ingredientsDeclared, asin,
  labelImages: primary's, falling back to other's,
  secondaryVerification: other.verification }
```
`offerOf(p)`: `{ source, store, url, price, priceMax, listPrice, inStock, variants }`.
Unmatched rows: `{ ...s or a, sources: ["shopify"]|["amazon"], offers: [offerOf(itself)] }`.

## 4. Prompts (verbatim)

### verify/extract.js — SYSTEM (superseded single-call extractor)
```
You read Indian dietary supplement listings (title, store description, product photos) and return the supplement facts exactly as the label states them. Rules:
- Use the label/facts-table photo as the source of truth for amounts. Description text is second. Never invent an amount; if the label is unreadable or absent, amount is null and note it.
- One row per ingredient as printed. printedName = the exact text on the label (with form and standardization). canonical = the generic ingredient name in plain English, no dose, no form words, no brand (e.g. "Withania somnifera root extract (5% withanolides) 600 mg" → canonical "ashwagandha", form "root extract", standardization "5% withanolides").
- amount is PER SERVING as the label defines a serving (e.g. 2 capsules). Report servingSize verbatim ("2 capsules", "1 scoop (30 g)").
- amountBasis: "elemental" when the label says elemental / "as X" / gives the mineral itself (e.g. "Magnesium (as magnesium glycinate) 200 mg" → 200 mg elemental); "compound" when it lists the salt weight ("Magnesium glycinate 1000 mg"); "unknown" if unclear.
- Proprietary blends: listed with amount null and isPartOfBlend true, blendName set; if the blend total is printed put it in blendTotalMg.
- Excipients (capsule shell, fillers, flavour, sweetener, anti-caking) go in excipients[], not ingredients[].
- kind: "single" (one active), "multi" (several actives in one product), "bundle" (several separate products sold together), "not_supplement" (food, drink, cosmetic, equipment).
- confidence 0-1 for the whole extraction; list every doubt in notes.
- ratingSeen: if a rating/review count is visible in the text, report it, else null.
```
Schema (`SCHEMA`): `type object`, `kind` enum [single,multi,bundle,not_supplement], `brand`, `productName`, `servingSize`, `servingsPerContainer`, `doseDirections`, `ingredients[]` (printedName, canonical, amount, unit, amountBasis enum[elemental,compound,unknown], form, standardization, isPartOfBlend, blendName, blendTotalMg, source enum[label_image,description,title]), `excipients[string]`, `labelImageIndex`, `confidence`, `notes` — all required at both levels, `additionalProperties: false`.

### verify/extract2.js — CLASSIFY_SYS (production classifier, call 1)
```
You see a contact sheet of every listing photo for one product from an Indian online store, numbered 0..N, plus the listing title and variants. Decide what the listing is and which photos show the supplement facts / ingredients panel.
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
labelTileKinds: one entry per labelTiles entry, in the same order. "pack_photo" = a photograph of the physical pack, where the panel is printed on the bottle, pouch or carton itself (it curves, catches light, sits at an angle, or is surrounded by the rest of the pack). "spec_graphic" = a flat rendered image the brand designed for the listing, where the panel is typeset on a plain background with no packaging around it. Brands routinely publish a spec graphic whose numbers disagree with the pack they actually ship, so this distinction decides which numbers we keep.
```
CLASSIFY_SCHEMA: `listing` enum[supplement,not_supplement], `pack` enum[single,multipack,bundle,value_pack,n/a], `unitsInContainer`, `bundleComponents[string]`, `labelTiles[number]`, `labelTileKinds[enum pack_photo|spec_graphic]`, `frontTile`, `reason` — all required, `additionalProperties:false`.

### verify/extract2.js — FACTS_SYS (production facts reader, call 2)
```
You read the supplement facts of one Indian dietary supplement from its label photo(s) and listing text. Return the facts exactly as printed.
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
- confidence 0-1 for the whole extraction; list every doubt in notes. If no label photo was provided, work from text only and cap confidence at 0.5.
```
FACTS_SCHEMA: `brand`, `productName`, `formFactor`, `servingSize`, `servingsPerContainer`, `netQuantity`, `doseDirections`, `rows[]` (role enum[active,macro,excipient], printedName, canonical, amount, unit, amountBasis enum[elemental,compound,unknown], form, standardization, isPartOfBlend, blendName, blendTotalMg, source enum[label_image,description,title]), `confidence`, `notes` — all required, `additionalProperties:false`.

### certs_llm.js — SYS
```
You decide which quality certifications and tests a supplement listing claims FOR THE FINISHED PRODUCT.
Rules:
- Only the product itself counts. A certification held by one raw ingredient or by the manufacturing site's supplier ("KSM-66 has USP and NSF certifications") is ingredientLevel, not the product's.
- "Tested for X" is testing. "Free from X" or "no X" is a purity claim, not testing. Keep them apart.
- Named third-party programmes only where actually named: Informed Sport, Informed Choice, NSF Certified for Sport, Labdoor, USP Verified, Eurofins, NABL, WADA batch testing. The ordinary English words "informed choice" are not the programme.
- Ignore generic marketing ("highest quality", "trusted by athletes") and ignore background explanation of what an agency does.
- A licence or registration is not a quality test: FSSAI, AYUSH, ISO and GMP describe the factory or the legal listing. Record them, but as facility/licence, never as product testing.
- NABL is India's lab accreditation body. "NABL-accredited lab" says the lab is credible; it is product testing only when the text says the product was tested there. On its own it is facility/licence.
- Indian whey listings often advertise a nitrogen or amino "spiking" check, and protein-accuracy testing. Record those as protein_spiking and protein_accuracy, not as generic third_party_lab.
- Each entry needs the verbatim quote it came from. If you cannot quote it, do not record it.
Return only what the text supports. Empty lists are the right answer for most listings.
```
SCHEMA (abridged field list; enums given in full above in §3): `productTesting[]` (kind enum 16 values: third_party_lab, heavy_metals, banned_substances, microbial, potency_assay, protein_accuracy, protein_spiking, aflatoxin, pesticide, solvent_residue, allergen, identity_dna, adulteration, radiation, stability_shelf_life, other; programme; everyBatch; quote), `purityClaims[string]`, `facilityOrLicence[enum]`, `dietFlags[enum]`, `ingredientLevel[string]`, `fssaiLicence`.

### marks.js — SYS
```
You are looking at photos of an Indian supplement's packaging. List ONLY the certification and testing marks that are actually legible in the images: logos, stamps, seals, licence numbers, printed claims on the pack.
Read what is printed. Never infer a mark from the brand, the product type or the design, and never guess text that is too small or blurred — mark that legible:false instead.
Typical Indian pack marks: the FSSAI logo and its 14-digit licence number, the green dot (vegetarian) or brown dot (non-vegetarian), GMP, HACCP, ISO, FDA registered, AYUSH, USDA Organic, India Organic, Halal, Kosher, Informed Sport, Informed Choice, NSF, Labdoor, "Dope Free", "Banned Substance Tested", "Lab Tested", "Third Party Tested", "Heavy Metals Tested", "No Added Sugar", "Gluten Free", "Vegan".
Do not list marketing lines that are not certification or testing claims ("clinically proven results", "trusted by athletes", "transparent dosing"), and do not list packaging marks such as recyclability unless asked. Recyclable/plastic-neutral marks go in otherPackMarks.
A pack often prints an FSSAI licence for the marketer and another for the manufacturer; record both with their role rather than picking one.
Also copy out the allergen statement if the pack prints one. Indian packs carry two different kinds and they must not be merged: what the product CONTAINS ("Contains Milk", "Contains Soy") and what the SHARED FACILITY may introduce ("Manufactured in a facility that may contain traces of Soy and Nuts", "may contain traces of"). Quote the sentence verbatim as well, since an allergy decision should rest on the exact wording.
```
SCHEMA field list given in §3.

### marks_probe.js — SYS (near-duplicate of marks.js, shorter, used only for the A/B probe)
```
You are looking at photos of an Indian supplement's packaging. List ONLY the certification and testing marks that are actually legible in the images: logos, stamps, seals, licence numbers, printed claims on the pack.
Read what is printed. Do not infer a mark from the brand, the product type or the design. If text is too small or blurred to read, do not guess it.
Typical Indian pack marks: FSSAI logo and 14-digit licence number, the green dot (vegetarian) or brown dot (non-vegetarian), GMP, HACCP, ISO, FDA registered, AYUSH, USDA/India Organic, Halal, Kosher, Informed Sport, Informed Choice, NSF, Labdoor, "Dope Free"/"Banned Substance Tested", "Lab Tested", "Third Party Tested", "No Added Sugar", "Gluten Free", "Vegan", recyclable marks.
```

### review.js — SYS
```
You are auditing a supplement product record that was extracted from label photos. You get the label photo(s) and the extracted record.
Check ONLY against what is visible in the photos (and the title). Report:
- amount/unit errors on ingredient rows (wrong number, wrong unit, per-100g copied as per-serving, group total copied to members)
- actives printed on the label but missing from the rows
- rows that are NOT on the label (invented from description)
- wrong servingSize / servingsPerContainer / formFactor
- listing is not actually a consumable supplement (topical, gear, food item)
verdict: ok = nothing material wrong; minor = small naming/unit-basis nits, amounts right; major = any amount wrong, active missing/invented, or not a supplement.
If the photos show no readable supplement-facts panel, say so with verdict "no_label" and list nothing as wrong.
Be strict on numbers, lenient on naming.
```
SCHEMA: `verdict` enum[ok,minor,major,no_label], `notSupplement`, `issues[]` (kind enum[wrong_amount,missing_active,invented_row,wrong_serving,wrong_form,other], row, extracted, label, note), `confidence`.

### _parked/resolve2.js — PICK_SYS (slug tie-break; parked, DB-dependent)
```
You map supplement label ingredients to a fixed catalog of ingredient slugs. For each item you get the printed label text, a generic name, and candidate catalog entries. Pick the candidate that IS that ingredient (same substance; a specific form of it is fine: "magnesium bisglycinate" → magnesium, "KSM-66 ashwagandha" → ashwagandha, "biotin" → vitamin_b7, "L-leucine" → leucine only if a leucine entry exists). Pick "none" when no candidate is the same substance (e.g. sodium is not iron, leucine is not glycine, saturated fat is not omega_3). Never guess.
```
PICK_SCHEMA: `picks[]` = `{i: number, slug: string}`.

## 5. Hardcoded things that should become config

- `STORES` list (24 → 30 entries with three dated append comments) in `fetch_shopify.js` — should be one config/data file shared with `STORE_BRAND` in `clean.js` (today they're maintained independently and can drift; e.g. a store added to `STORES` needs a matching `STORE_BRAND` entry or falls back to the free-text vendor field).
- `STORE_BRAND` map (30 stores → canonical brand name) in `clean.js`.
- `SUB_BRANDS` regex list (sub-brands hiding inside a store) in `clean.js`.
- `NON_SUPP` regex — duplicated with drift across `bulk_input.js`, `inspect.js`, `verify/sample.js` (sample.js's copy is missing `oil\b.*(hair|face|skin|body)` and a few others that the other two have).
- `CLAIMS` regex/name pairs (26 certification patterns) in `certs.js`.
- `BRAND_NAME` / `ALIASES` maps for Amazon brand-string normalization, duplicated between `amazon_clean.js` (`BRAND_NAME`) and `amazon_prepare.js` (`ALIASES`) — same brand set, different shapes, must be kept in sync by hand.
- `GEAR` / `FOOD` / `TOPICAL` / `NON_FORM` regexes in `amazon_prepare.js`, and a second `TOPICAL`/`TOPICAL_FORM` pair in `clean.js` and a third in `amazon_clean.js` — three independently maintained topical/non-supplement classifiers.
- Model names hardcoded per script with mismatched defaults: `verify/extract.js` defaults `gpt-5.6-luna`; `verify/extract2.js`, `certs_llm.js`, `marks.js`, `marks_probe.js`, `review.js` default `gpt-6-luna` (review.js CLI default says `gpt-5.4-mini` in its usage comment but the flag default in code is `gpt-6-luna`). `PRICE` table (cost per model) hardcoded and duplicated between `extract2.js` and `marks.js`/`marks_probe.js`/`certs_llm.js` (each only knows the one price row it needs).
- Image widths: `?width=1200` (extract.js), `?width=1600` (extract2.js label reads, marks.js, marks_probe.js, review.js), `?width=640` (grid.js tile fetch) — three different magic widths with no shared constant.
- `MAX_IMAGES = 3` (extract.js) vs extract2.js's cap of 4 label images (`slice(0,4)`) and grid.js's `MAX_TILES = 16`.
- Thresholds: `STOP_OOS = 0.34` (amazon_brand.js), `lowRes` threshold `800px` (extract2.js), confidence cutoff `< 0.7` for `unverified_low_confidence` (repeated in `clean.js`, `amazon_clean.js`, `fill_apply.js`), merge match threshold `bestScore >= 0.62` and dose-match floor `0.8` (merge.js), amazon_fill.js match threshold `best.s < 0.5`, amazon_price.js requires `shared >= 2` tokens.
- Vote/agreement rules in `adjudicate.js` (2/2, 2/3, "pack wins", "1/1 keeps") are implicit control flow, not data — a genuine algorithm, but the ±2% numeric tolerance (`same()`) and the read-directory precedence order (`r0=read3 > r1=extracted > r2=read2/recheck > r3=effort_high`) are hardcoded and undocumented outside a comment.
- Apify actor id `junglee~amazon-crawler`, poll interval `12000`/`15000` ms, `proxyCountry: "IN"` repeated literally in `amazon_brand.js`, `amazon_fill.js`, `amazon_price.js`, `verify/apify_probe.js` — four copies of the same Apify request/poll boilerplate.
- `.env`/`.env.local` dotenv-loading boilerplate (the `for (const root of [...]) { if (fs0.existsSync(...)) ... }` block) is copy-pasted verbatim into at least 7 files (`extract2.js`, `certs_llm.js`, `marks.js`, `marks_probe.js`, `amazon_brand.js`, `amazon_fill.js`, `amazon_price.js`, `resolve2.js`) with two different root-depth guesses per file.

## 6. Duplication and structural problems

- **Three copies of the topical/non-supplement classifier** (`clean.js`, `amazon_clean.js`, `amazon_prepare.js`) with different regex bodies covering overlapping but not identical term sets — a term added to one classifier silently doesn't apply to the others.
- **`NON_SUPP` regex duplicated 3x** with drift (see §5) between `bulk_input.js`, `inspect.js`, `verify/sample.js`.
- **Brand alias tables duplicated in two shapes**: `amazon_clean.js`'s `BRAND_NAME` (slug → display name) and `amazon_prepare.js`'s `ALIASES` (slug → match tokens) cover the same brand set but must be updated in two places for a new brand.
- **Key construction is inconsistent across the pipeline**: Shopify keys are `${store}__${id}`; Amazon keys appear in at least three different forms depending on which script wrote them — `amazon__${asin}` (certs.js output, clean.js's `keywordClaims` lookup), `amazon.in__${x.id}` (amazon_clean.js's own `ck`), and `${shopifyKey}__${asin}` (amazon_fill.js output ids, later split back apart in `fill_apply.js` by `String(x.id).split("__")`). `certs_llm.js` and `marks.js`/`amazon_clean.js` read/write a mix of `amazon__` and `amazon.in__` prefixes that must be kept aligned by convention, not by any shared key-builder function.
- **`extracted`/`read3`/`read2`/`recheck`/`effort_high` directory scheme is ad hoc**: which directory is "the current read" for a given product is resolved independently in `adjudicate.js` (explicit dirs object with fallback order) and `clean.js` (separate `SRC` map unioning only `extracted`+`read3`, ignorant of `read2`/`recheck`/`effort_high` except via `adjudicated.json`). A new read generation requires updating both files' logic by hand.
- **`readDir()` helper (scan a directory of per-key JSON files into a keyed object) is copy-pasted** into `clean.js` and `amazon_clean.js` verbatim.
- **The dotenv-bootstrap block** is pasted into 7+ files with two slightly different relative-root guesses (`../../..` vs `../../../../../..`), rather than one shared `require("./env")` module.
- **Apify run/poll/fetch-items boilerplate** (`startRun`/`waitRun`/`items` in `amazon_brand.js`, near-identical inline versions in `amazon_fill.js`, `amazon_price.js`, `apify_probe.js`) is duplicated 4 times with slightly different timeouts and item limits, no shared client module.
- **`verification` tier logic is computed independently 3 times** (`clean.js`, `amazon_clean.js`, `fill_apply.js`) with the same 5-tier ladder and `< 0.7` cutoff, rather than a shared function.
- **Dirs are "unioned ad hoc"**: `amazon_prepare.js` discovers brand pull files by *excluding* a hardcoded list of known-derived filenames (`prepared|dropped|extract_input|...`) rather than including only files matching a "raw pull" naming convention — any new derived-output filename added elsewhere must also be added to this exclude regex or it gets misread as a brand pull.
- **`certs_llm.js` and `marks.js` run against different universes** (certs_llm can be scoped by `catalog.json` if present, i.e. pre- or post-merge; marks.js is hardcoded to always read `catalog.json`, i.e. post-merge only) — meaning certs_llm is designed to possibly run before merge exists, but marks.js is not, an implicit ordering dependency not stated anywhere except by what files exist when each is invoked.
- **`extract.js` (single-call) is dead/superseded** by `extract2.js` (two-call) but remains in the tree fully wired with its own SYSTEM/SCHEMA — a maintenance trap if someone edits prompts in the wrong file.
- **`merge.js`'s dose fingerprint (`doseKey`) and `certs.js`'s unit factor tables (`F`)** duplicate the same unit→mg conversion table (`g/gm→1000, mg→1, mcg/µg/ug→0.001`) independently from `adjudicate.js`'s own copy of the same table (with `cfu`/`billion cfu` added) — three separate unit tables that must stay numerically consistent by hand.

## 7. What a clean modular redesign would separate into

Grounded in what the code actually does, not an idealized guess:

- **`sources/`** — one adapter per source type, each responsible only for fetch + minimal normalize to a shared "raw listing" shape (`{store, id, url, title, vendor, productType, tags, bodyHtml, variants, images}`): a Shopify adapter (today's `fetch_shopify.js`), an Apify/Amazon adapter (today's `amazon_brand.js` + the Apify run/poll/items helper duplicated 4x — should be one client module), and the brand/store config (`STORES`, `brands.txt`, `STORE_BRAND`, Amazon `ALIASES`/`BRAND_NAME`) as one data file per source, not scattered across `fetch_shopify.js`, `clean.js`, `amazon_clean.js`, `amazon_prepare.js`.
- **`filtering/`** — the pre-extraction gate that's currently `bulk_input.js` + `amazon_prepare.js` + the drop-regexes duplicated in `inspect.js`/`verify/sample.js`: one shared `NON_SUPP`/`GEAR`/`FOOD`/`TOPICAL` classifier module used everywhere a listing needs to be judged "worth extracting" or "worth keeping," instead of three drifting copies.
- **`extraction/`** — `verify/extract2.js` + `verify/grid.js` is already close to a clean unit: classify → pick label tiles → read facts, keyed by product id, resumable by file existence. This is the one piece that should stay a single well-tested module; retire `verify/extract.js` (superseded single-call version) entirely rather than keep it live.
- **`adjudication/`** — `adjudicate.js`'s majority-vote logic is sound and self-contained; it should own the "which read directory is authoritative" policy as an explicit ordered config, not duplicated in `clean.js`'s separate `SRC` union.
- **`enrichment/`** — the three claim/mark layers (`certs.js` regex, `certs_llm.js` judged text claims, `marks.js` pack-photo marks) are a legitimate three-tier design (claimed vs judged vs printed) and should stay separate signals as they are now, but should run against one canonical "extraction complete" list (post-adjudication, pre-merge) rather than being invoked once pre-merge and again reading `catalog.json` post-merge with an implicit ordering dependency.
- **`clean/`** — `clean.js`/`amazon_clean.js` do three unrelated jobs that should split: (a) applying patches (adjudicated rows, Amazon-fill, certs, marks, price) onto raw extractions, (b) business-rule rejection (bundle/multipack/topical/no-facts), (c) brand normalization + net-quantity parsing + dedup. Splitting these would let the two nearly-identical cleaners (Shopify vs Amazon) share (a) and (b) as one function each, with only brand/field-mapping differing per source.
- **`export/`** (merge + final catalog) — `merge.js` is already isolated and pure; it's the right shape. Its unit-conversion table (`F`) should be the same shared table `adjudicate.js` and `certs.js` use, not a third copy.
- **A cross-cutting `lib/` for what's currently copy-pasted**: the dotenv bootstrap, the Apify run/poll/items client, the `readDir()` per-key-JSON-file loader, the verification-tier computation, and the key-builder (`${store}__${id}` for Shopify, one canonical Amazon key format instead of three). None of this is source- or stage-specific; all of it is duplicated 2-8 times today.

Slug resolution (`_parked/resolve.js`/`resolve2.js`) stays out of this worktree by design (no-DB rule) and is correctly deferred as its own later task, not part of this redesign's scope.
