# Catalog schema and import (2026-09-27)

DDL: `schema/catalog.sql` · unit normalisation: `schema/normalize.js` · loader: `stages/import.js`
· tests: `test/import.test.js` (`node --test test/import.test.js`).

Four tables, all reference data: `supplement_products`, `product_ingredients`, `product_offers`,
`catalog_snapshots`. They are written **only** by `stages/import.js` from a finalized snapshot,
and read by os-backend. They hold no user data, no user foreign keys, and nothing here cascades
into a user row.

---

## Why ingredient rows are a table, not a JSON column on the product

The LLM has two access patterns and they pull in opposite directions.

1. **Find products by ingredient and dose.** "A magnesium glycinate with at least 200 mg elemental
   magnesium per serving, under Rs 1,500." That is a filter on *one line inside* the product:
   `canonical_norm = 'magnesium' AND amount_mg >= 200`. With rows in a table this is an index scan
   on `product_ingredients (canonical_norm, amount_mg)` returning a handful of `product_key`s out
   of 2,771 products and ~46,600 ingredient lines. With the list in a `jsonb` column it is a
   sequential scan over every product, unnesting every array, per query — and a GIN index on the
   jsonb can match *containment* but cannot express `>=` on a number nested in an array element,
   so the dose half of the predicate stays a post-filter no matter what index you add.
2. **Read one product's lines back in printed order**, to show a supplement facts panel or reason
   about the whole formula. That is `WHERE product_key = $1 ORDER BY position` — one index, one
   sequential read of rows already stored together.

A table serves both. A jsonb column serves only the second. The pattern that matters most is the
first one, because it is the one that runs on every recommendation.

Two more reasons that only became obvious with the real data:

- **The units are a mess and the mess must be queryable.** 59 distinct normalised units appear
  across the real 46,607 lines, and the raw strings include `kcal`/`Kcal`, `g`/`gm`, `IU`/`I.U.`,
  `q.s.`/`Q.S.`, `billion CFU`, `g/100 g protein`. Columns let `unit_norm` and `amount_mg` be
  *derived once at import* and indexed. Inside a jsonb blob the same derivation would have to be
  redone in every query, or duplicated into a second denormalised structure anyway.
- **Blends.** `is_part_of_blend` / `blend_name` mean "this line's amount is not independent". A
  dose filter that ignores that flag recommends a proprietary blend as though its components were
  individually dosed. As a column it is a one-word addition to a WHERE clause.

What deliberately stays `jsonb` on the product: `label_images`, `checks`, `claims`, `pack_marks`,
`allergens`, `fssai_licences`. Nothing filters or aggregates on those — they are read back whole
with the product, their shapes still move with the extraction prompt, and each would otherwise
cost two to four more tables for no query benefit.

---

## `amount` is printed; `amount_mg` is derived, and often NULL

`amount` and `unit` are stored **exactly as printed on the label**. Percentages stay percentages
(`7 %`), never converted — an owner decision, and the right one: a percentage on an Indian
supplement label may be `% w/w` of an extract, of the serving, or of an RDA, and which one is not
knowable from the number.

`amount_mg` exists only so a dose filter can be written as one comparison. It is populated
**only for unambiguous mass units** — `kg`, `g` (and `gm`/`gms`), `mg`, `mcg` (and `µg`/`ug`) —
and is `NULL` for everything else: `%`, `IU`, `CFU`, `kcal`, `ml`, counts, `q.s.`, ratio units
like `g/100 g protein`, equivalence units like `mcg RAE` / `mg NE` / `mg TE`, and any unit
`normalize.js` did not recognise. Measured on the legacy 46,607 lines: 31,194 get an `amount_mg`,
15,413 do not (11,181 of those have no printed unit at all — macro rows).

The two conversions that look tempting and are wrong:

- **IU → mg is vitamin-specific.** 1 IU is 0.025 mcg of vitamin D3 and 0.667 mg of vitamin E
  (as d-alpha-tocopherol) and something else again for vitamin A. A generic factor silently
  corrupts the dose column. 219 lines are IU.
- **`mcg RAE` / `mcg DFE` / `mg NE` are not their base unit.** They already fold a potency ratio
  in. Treating `mcg RAE` as `mcg` overstates a beta-carotene product several-fold.

**Consequence for any query:** a dose filter on `amount_mg` silently excludes every IU, CFU and
percentage row. When the ingredient is one of those (vitamin D, vitamin E, probiotics, standardised
extracts), filter on `unit_norm` + `amount` instead. This is the one sharp edge in the schema.

`unit_norm` normalisation is the single source of that mapping and is pure and unit-tested:
`kcal|Kcal|calories → kcal` · `g|gm|gms → g` · `mcg|µg|ug → mcg` · `IU|I.U. → IU` ·
`q.s.|Q.S. → qs` · `% → pct` · `billion CFU → bn_cfu` · `million CFU → mn_cfu` ·
`g per 100 g protein` and `g/100g protein` both → `g_per_100g_protein`. An unrecognised unit
passes through lowercased rather than being dropped, so it stays greppable and a later pass can
map it; it just never gets an `amount_mg`.

---

## How a user stack row references the catalog

A user's stack row stores **a reference and the user's own dose**. It never copies catalog data.

```sql
-- lives in os-backend's schema, NOT here
CREATE TABLE user_stack_items (
  id                 bigserial PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  product_key        text,          -- -> supplement_products.key; NULL for a free-text entry
  ingredient_slug    text,          -- what the user is actually taking ("magnesium glycinate")
  dose_amount        numeric,       -- the user's dose, not the label's
  dose_unit          text,
  servings_per_dose  numeric,       -- "2 capsules" -> 2
  schedule           jsonb,
  started_at         timestamptz,
  stopped_at         timestamptz
);
```

Rules:

- **`product_key` is a soft reference, deliberately not a cross-database FK.** The catalog is
  imported from a snapshot and lives on its own release cycle; a user row must not be able to
  block or be broken by an import. Resolve it with a join at read time and tolerate a miss.
- **Never copy brand, product name, price, ingredient rows or images into the stack row.** Those
  change with every snapshot. A stack that copied them shows the user last quarter's price and
  last quarter's formula, and there is no way to tell that it has gone stale.
- **The dose is the user's.** The label says what one serving contains; the user may take two
  capsules or half a scoop. `dose_amount` / `servings_per_dose` on the stack row is the only
  authority on what they actually take. Multiply by the product's ingredient rows to compute real
  intake — do not assume one serving.
- **`ingredient_slug` survives without a product.** A user can log "magnesium, 200 mg" with no
  product at all, and a product that is later delisted must not erase what they are taking. This
  is exactly why import retires rows (`active = false`) instead of deleting them.
- Recommendation reads should filter `active = true`; a stack read must not, or a delisted product
  vanishes from the user's own list.

---

## Products are retired, never deleted

`import` sets `active = false` on every product that was not in the snapshot it just loaded, in a
single scoped `UPDATE ... WHERE active = true AND snapshot_version <> $1`. It issues no `DELETE`
against `supplement_products` at all. Ingredient and offer rows *are* replaced per product, but
always scoped by `product_key` — an ingredient list is only meaningful as a set, so it is deleted
and reinserted wholesale for the one product being upserted. The test suite asserts that no
statement the importer can emit is an unscoped `DELETE` or `UPDATE`.

---

## Why the env vars are `DATABASE_URL_DEV` / `DATABASE_URL_PROD`

In os-backend a bare `DATABASE_URL` means **prod** in `.env` and **dev** in `.env.local`, so which
database a command hits depends on which file happened to be loaded. That trap has destroyed real
data there more than once.

This repo has no `DATABASE_URL`. The only accepted names are `DATABASE_URL_DEV` and
`DATABASE_URL_PROD`; each names its target in the variable itself, so a URL cannot be
misidentified by being in the wrong file. A bare `DATABASE_URL` in the environment is **ignored**,
and if it is the only thing set the importer fails with a message telling you to copy it into the
correctly named variable once you have confirmed where it points. The target is *also* chosen by
an explicit `--target` flag, so the env var alone never decides.

---

## Import contract

```
node stages/import.js --snapshot data/snapshots/catalog-v<N>.json [--target dev|prod] [--yes-prod] [--dry-run] [--force]
```

- **The `.sha256` sidecar is verified before the database is touched.** A mismatch or a missing
  sidecar aborts with zero statements issued. The snapshot is paid LLM output; a truncated or
  hand-edited file must never reach a table.
- **Version.** Taken from the filename (`catalog-v<N>.json`) or a top-level `version` field. A
  version already present in `catalog_snapshots` is refused unless `--force`, and the refusal
  happens before any write.
- **Idempotent.** Products are upserted on `key`; the same snapshot imported twice issues the same
  statements with the same parameters and leaves the same rows. Snapshots with a duplicate `key`
  or a row without a `key` are rejected at parse time.
- **Batching.** One transaction per 200 products, so a failure mid-import leaves whole products
  committed or whole products untouched, never half a product. The retire pass and the
  `catalog_snapshots` row are one final transaction after all products are in.
- **Prod requires `--target prod` AND `--yes-prod`**, prints the host and the URL with the
  password masked, then waits 5 s. `--dry-run` parses, verifies the sha, counts, and opens no
  connection at all.
- **`pg` is required lazily**, so `--dry-run` and the test suite run without it installed. Tests
  inject a fake client; nothing in `test/` can reach a real database.

## For the owner to look at

1. **`amount_mg` is NULL for IU / CFU / % rows**, by design. Any recommendation query written only
   against `amount_mg` will silently skip vitamin D, vitamin E and probiotics. If a per-vitamin
   IU→mcg table is wanted later, it belongs in `normalize.js` keyed on `canonical_norm`, not as a
   generic factor — flagging it rather than deciding it.
2. **`checks`, `claims` and `pack_marks` are jsonb.** Right now nothing queries them. If "only
   third-party tested products" becomes a hard filter, the testing marks want promoting to their
   own table or at least a generated boolean column.
3. **No cross-source dedupe.** Per the design there is no merge stage, so the same physical product
   sold on its own store and on Amazon is two rows with two keys. Nothing in this schema links
   them yet; a `duplicate_of text REFERENCES supplement_products(key)` column or a separate
   link table is the obvious place when that lands.
4. **`servings_per_container` is numeric but `serving_size` and `net_quantity` are text**, kept as
   printed ("2 capsules", "250 g"). Cost-per-dose therefore cannot be computed in SQL. If that
   number is wanted, it needs a parsed `serving_units` + `serving_unit_norm` pair filled at
   extraction, not at import.
5. **`position` is the printed order and is reassigned on every import.** It is a display order,
   not a stable identifier — nothing outside this repo should store a `product_ingredients.id`.
