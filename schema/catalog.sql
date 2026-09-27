-- supplements-catalog: reference-data tables.
--
-- These tables are CATALOG REFERENCE DATA ONLY. They are written exclusively by
-- stages/import.js from a finalized snapshot, and read by os-backend. They contain
-- no user data, no user foreign keys, and nothing here cascades to a user row.
-- A user's stack references supplement_products.key and carries its own dose
-- (see docs/SCHEMA.md "How a user stack row references the catalog").
--
-- Apply with:  psql "$DATABASE_URL_DEV" -f schema/catalog.sql
-- Idempotent: every statement is IF NOT EXISTS / OR REPLACE.

BEGIN;

-- ---------------------------------------------------------------------------
-- supplement_products: one row per listing (store+id, or amazon.in+ASIN).
-- No merge stage exists: cross-source duplicates are separate rows, linked later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplement_products (
  key                    text PRIMARY KEY,                -- "<store>__<id>" | "amazon.in__<asin>"
  source                 text NOT NULL,                   -- 'shopify' | 'amazon'
  store                  text NOT NULL,                   -- e.g. 'aceblend.com', 'amazon.in'
  external_id            text NOT NULL,                   -- Shopify product id or ASIN
  brand                  text,
  product_name           text,
  title                  text,
  form_factor            text,                            -- capsule|powder|tablet|sachet|bar|...
  is_food_form           boolean NOT NULL DEFAULT false,
  pack                   text,                            -- single|value_pack|multipack|bundle|n/a
  serving_size           text,                            -- printed, never parsed ("2 capsules")
  servings_per_container numeric,
  net_quantity           text,                            -- printed ("60 capsules", "250 g")
  units_in_container     integer,
  dose_directions        text,
  image_url              text,
  label_images           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [url, ...]
  verification           text,                            -- label_read | unverified_low_res |
                                                          -- unverified_low_confidence |
                                                          -- unverified_no_label | unverified_title_only
  confidence             numeric,                         -- 0..1 from extraction
  checks                 jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {rules:[], textCheck:{}|null, reread:bool}
  claims                 jsonb NOT NULL DEFAULT '{}'::jsonb,  -- text claims (testing/purity/facility/diet)
  pack_marks             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- marks read off the pack photo
  allergens              jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {contains, mayContainTraces, freeFrom, statement}
  fssai_licences         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{number, role}]
  description_text       text,
  notes                  text,
  schema_version         integer NOT NULL DEFAULT 1,      -- record shape version (record changes)
  snapshot_version       integer,                         -- catalog_snapshots.version that last wrote this row
  extracted_at           timestamptz,
  model                  text,
  active                 boolean NOT NULL DEFAULT true,   -- false = absent from the newest snapshot (never deleted)
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supplement_products_brand_idx        ON supplement_products (brand);
CREATE INDEX IF NOT EXISTS supplement_products_verification_idx ON supplement_products (verification);
CREATE INDEX IF NOT EXISTS supplement_products_active_idx       ON supplement_products (active);

-- ---------------------------------------------------------------------------
-- product_ingredients: one row per printed ingredient line, per product.
-- A table and not a jsonb column because the LLM's primary query is
-- "which products contain >= X mg of <ingredient>" -- see docs/SCHEMA.md.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_ingredients (
  id              bigserial PRIMARY KEY,
  product_key     text NOT NULL REFERENCES supplement_products (key) ON DELETE CASCADE,
  position        integer NOT NULL,          -- printed order on the label; stable per import
  role            text,                      -- active | macro | excipient
  printed_name    text,                      -- exactly as printed ("Vitamin B12 (as Methylcobalamin)")
  canonical       text,                      -- extraction's canonical name
  canonical_norm  text GENERATED ALWAYS AS (lower(btrim(coalesce(canonical, '')))) STORED,
  amount          numeric,                   -- as printed, NEVER converted
  unit            text,                      -- as printed ("mg", "Kcal", "billion CFU", "q.s.")
  unit_norm       text,                      -- normalize.js output ("mg", "kcal", "bn_cfu", "qs")
  amount_mg       numeric,                   -- ONLY for mass units g/mg/mcg; NULL for %, CFU, IU, kcal, ratios
  amount_basis    text,                      -- elemental | compound | unknown
  is_part_of_blend boolean NOT NULL DEFAULT false,
  blend_name      text,
  source          text,                      -- label_image | description | title
  flagged         boolean NOT NULL DEFAULT false
);

-- Ingredient lookup, then dose filter: the LLM's two-step access pattern.
CREATE INDEX IF NOT EXISTS product_ingredients_canonical_idx      ON product_ingredients (canonical_norm);
CREATE INDEX IF NOT EXISTS product_ingredients_canonical_dose_idx ON product_ingredients (canonical_norm, amount_mg);
-- Read a single product's rows back in printed order.
CREATE INDEX IF NOT EXISTS product_ingredients_product_idx        ON product_ingredients (product_key, position);

-- ---------------------------------------------------------------------------
-- product_offers: where to buy, and for how much. One row per offer per product.
-- Separate from the product because price/stock/rating change on every fetch
-- while the label facts do not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_offers (
  id           bigserial PRIMARY KEY,
  product_key  text NOT NULL REFERENCES supplement_products (key) ON DELETE CASCADE,
  source       text,                         -- 'shopify' | 'amazon'
  store        text,
  url          text,
  price        numeric,                      -- priceMin
  price_max    numeric,
  list_price   numeric,
  currency     text NOT NULL DEFAULT 'INR',
  in_stock     boolean,
  rating       numeric,
  review_count integer,
  seen_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_offers_product_idx ON product_offers (product_key);

-- ---------------------------------------------------------------------------
-- catalog_snapshots: the import ledger. One row per snapshot file imported.
-- Lets import refuse a version already present (without --force) and makes
-- "which snapshot produced this row" answerable from the DB alone.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_snapshots (
  version     integer PRIMARY KEY,
  sha256      text NOT NULL,                 -- sha256 of the snapshot JSON, verified before import
  row_count   integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by text                           -- os user / CI identity that ran the import
);

COMMIT;
