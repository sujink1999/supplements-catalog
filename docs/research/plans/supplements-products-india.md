# Phase 2: Indian supplement products

Status: planning (2026-09-12). Nothing built. Apify cost researched, see § Open.

## Goal

Suggest a **buyable Indian product** for a stack item, chosen by ingredients and dose,
filtered by the user's location. v1 scope:

- Ingredient vocabulary stays as is: DSLD-based `supp_ingredients` (~150 curated).
  Only additions are aliases for how Indian labels spell things
  ("Withania somnifera extract 5% withanolides" → `ashwagandha`).
- Products: Indian SKUs whose labels list ingredients per serving. Sports/wellness
  segment (HK Vitals, MuscleBlaze, Carbamide Forte, Wellbeing Nutrition, Fast&Up,
  Himalayan Organics, TrueBasics, Neuherbs, ...).
- **Out of scope**: Ayurvedic formulations, products with hidden proprietary blends,
  medications (separate plan, separate sources: NPPA, Jan Aushadhi, 1mg datasets).
- No affiliate programme. Images are downloaded into our own bucket.

## What already exists

- `supp_products` / `supp_product_ingredients` (schema: `src/db/schema/supplements.js`)
  copy DSLD's shape and are empty. Product ingredients reference `ingredient_slug`
  and model blends (`isPartOfBlend`, `blendId`).
- `supp_gap_queue` collects unmatched ingredient names; curation input only.
- `src/services/textMatch.js` is the only matcher allowed for slug resolution.
- `scripts/supplements/enrich_dsld.py` pulls DSLD synonyms per curated slug.

## Schema additions (additive only)

`supp_products`: `region` (`IN`), `asin`/`sku`, `url`, `price` + `currency`,
`imageUrl` (our bucket), `sourceImageUrl`, `servingsPerContainer`, `lastSeenAt`,
`available` bool, `sourceKind` (`apify_amazon` | `shopify` | `manual`),
`extractionConfidence`, `raw` jsonb (listing payload for re-extraction).

## Pipeline (one-time seed, re-run occasionally for price/stock)

Nothing here runs at request time. All of it is `scripts/supplements/products/*`.

1. **Fetch listings**
   - Apify Amazon scraper on amazon.in: one search per curated slug (~150 queries,
     top 20 results), plus a hand-picked ASIN list. Dedupe by ASIN.
   - Shopify `/products.json` for D2C brand stores: cleaner ingredient tables and
     brand-owned images. Match to ASINs by brand + normalized name.
   - Store raw JSON to `scripts/e2e/out/products/` (gitignored).
2. **Extract** (LLM, structured output)
   - Input: title, bullets, description, "Ingredients"/"Important information",
     and the label image when text has no table.
   - Output: `{brand, name, servingSize, servingsPerContainer,
     ingredients:[{name, amount, unit, form, standardization, isPartOfBlend}]}`.
   - Resolve `name` → slug through `textMatch` with the DSLD alias table.
     Miss → `supp_gap_queue`. Amount unknown (blend) → `amount: null`,
     `isPartOfBlend: true`.
3. **Review**
   - Flag rows for a human pass: unmatched ref, dose outside the catalog's
     published range, unit not convertible by `engine/units.js`, blend-only
     products. Everything else auto-inserts.
4. **Images**
   - Download at ingest, upload to Vercel Blob, store our URL. Keep the source URL.
5. **Insert** into `supp_products` / `supp_product_ingredients` with `region: "IN"`.

## Suggestion query (the actual feature)

For a stack item: products in the user's region covering all of its ingredient refs,
dose per serving within (or scalable to) the item's amount, ranked by coverage,
dose closeness, then price per serving. Return top 3 with image, price, url.
Exposed as a read on the supplements module; Protocol/LLM tools consume it later.

## Scraping options (decided: Apify + Shopify; rest are fallbacks)

| option | what | cost | when |
|---|---|---|---|
| Apify `junglee/amazon-crawler` | search or ASIN list on amazon.in, JSON out | $3 to $5 / 1000 rows, $5/mo free credit | primary |
| Shopify `/products.json` on D2C stores | open endpoint, images + descriptions + variants | free | primary, for clean ingredient tables |
| Apify community Amazon actors | cheaper (<$1 / 1000), schema unverified | fallback if junglee lacks the ingredients box |
| ScraperAPI | ~$2.45 / 1000 Amazon pages | fallback if Apify blocks on amazon.in |
| Bright Data Amazon dataset | prebuilt, $250 / 100k records | no, overkill |
| Manual URL list + single fetch | hand-picked SKUs, fetch once | free | top-up for what search misses |
| Amazon Associates PA-API | licensed images/prices | rejected (affiliate) |

## Test run (before the bulk)

Goal: know, from ~150 items and under $2, whether the bulk job will give us what
extraction needs.

1. **Slugs**: ashwagandha, magnesium-glycinate, creatine, omega-3, vitamin-d3, zinc,
   vitamin-b12, whey-protein, l-theanine, iron. One amazon.in search each, top 15.
2. **Apify**: run junglee on those 10 queries with detail pages on. Save the dataset
   to `scripts/e2e/out/products/test-apify.json`.
3. **Shopify**: fetch `/products.json?limit=250` from three D2C stores (HK Vitals,
   Wellbeing Nutrition, Carbamide Forte; confirm each is Shopify by the endpoint
   answering). Save alongside.
4. **Verify the payloads** (script, `scripts/supplements/products/inspect.js`):
   - per item: has image URL(s)? has brand? has price in INR? has any text block that
     contains a per-serving ingredient line ("Each serving contains", "mg", "IU", "%")?
   - count: % with ingredient text, % with only bullets, % with nothing usable
     (needs the label image).
   - amazon.in confirmed if titles/prices are INR and ASINs resolve on amazon.in.
5. **Extraction dry run**: run the extraction prompt over 50 items. Record slug match
   rate through `textMatch`, blend rate, and rows that would hit review.

Pass criteria for going bulk: >70% of items have ingredient text or a readable label
image, and >80% of extracted ingredient names resolve to a slug. Below that, add the
Shopify source for the ingredient table or switch to label-image extraction by default.

## Bulk run

- 150 curated slugs x top 20 on amazon.in, plus Shopify catalogs for every brand
  found more than twice in the search results, plus the manual top-up list.
- Dedupe on ASIN, then on normalized `brand + name` across sources (Shopify row wins
  for ingredients, Amazon row wins for price and availability).
- Keep raw payloads on disk (gitignored). Extraction and insert run from those files,
  so re-extraction never means re-scraping.

## Matching products to our ingredients

Two different matches, in this order.

**1. Ingredient name → slug** (per extracted ingredient row)
- Extraction returns the name as printed ("Magnesium Bisglycinate Chelate 400 mg",
  "Withania somnifera root extract (5% withanolides)").
- The LLM also returns a `canonical` guess (plain English generic name, no dose, no
  form words). Both go through `src/services/textMatch.js` against
  `supp_ingredients.name` + `aliases` (DSLD synonyms already loaded there).
- Score tiers: exact/alias hit → accept. Phrase/words tier → accept, mark
  `matchKind`. Fuzzy only → send to review with `nearestList` suggestions. Miss →
  `supp_gap_queue` with the printed name.
- Form is kept separately (`form: "bisglycinate"`), it never decides the slug.
  Standardization ("5% withanolides") is kept as text on the row.
- Alias growth loop: every reviewed miss that maps to an existing slug adds the printed
  name to that slug's `aliases`, so the next run auto-matches. This is how the Indian
  spellings accumulate; no separate alias project.
- Elemental vs compound: "Magnesium glycinate 400 mg" may be compound weight, our
  dose range is elemental. Extraction flags `amountBasis: elemental | compound |
  unknown`; `unknown` goes to review. Known conversions live in `engine/units.js`.

**2. Stack item → product** (the suggestion query, at read time)
- Input: the item's `ingredients[]` (`ref`, `amount`, `unit`) and the user's region.
- Candidates: products in region with an ingredient row for every ref (single-ingredient
  items are the common case; multi-ref matches need all refs covered, extra ingredients
  allowed but penalised).
- Score: coverage (all refs present) → dose closeness per serving, allowing whole
  multiples (2 caps = target) → fewer extra ingredients → price per serving.
- Blend rows (`amount: null`) never satisfy a dose match; they can only be listed as
  "contains, amount unknown".
- Result: top 3 with image, price, url, and the per-serving amounts so the UI can show
  "2 capsules = 400 mg".

## Sizing

~800 to 1500 SKUs covers the ~150 curated ingredients. Extraction cost is trivial.
Ongoing cost is re-running fetch for price and availability.

## Open

- Apify cost (researched 2026-09-12): `junglee/amazon-crawler` is pay-per-result at
  $3 to $5 per 1000 items (free tier gives $5/month credit). 150 searches x 20 plus
  detail pages is ~3000 to 6000 billed rows, so **$9 to $30 one-time**; 3000 ASIN
  detail pages ~$9 to $15. Community actors go under $1/1000 but schema is unverified.
  Not confirmed by docs: amazon.in coverage and whether the supplement
  "Important information"/ingredients box is a returned field. Do a ~150 item test
  run (under $2) before the full job. Alternatives: ScraperAPI ~$2.45/1000 Amazon
  pages, Bright Data prebuilt dataset $250/100k records, Zyte from ~$1/1000.
- Which D2C stores are Shopify (verify per brand).
- Image rights: brand packshots used for the product we recommend; store source URL.
