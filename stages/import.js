#!/usr/bin/env node
/**
 * stages/import.js -- load a finalized snapshot into the catalog tables.
 *
 *   node stages/import.js --snapshot data/snapshots/catalog-v3.json
 *   node stages/import.js --snapshot data/snapshots/catalog-v3.json --dry-run
 *   node stages/import.js --snapshot data/snapshots/catalog-v3.json --target prod --yes-prod
 *
 * Flags
 *   --snapshot <path>   required; its `<path>.sha256` sidecar must match before the DB is touched
 *   --target dev|prod   default dev
 *   --yes-prod          additionally required for --target prod
 *   --dry-run           parse, verify sha, count, print; never connects
 *   --force             re-import a version already recorded in catalog_snapshots
 *
 * WHY THE ENV VARS ARE NOT CALLED DATABASE_URL
 * --------------------------------------------
 * In os-backend a bare `DATABASE_URL` means PROD in `.env` and DEV in `.env.local`,
 * so which database a shell command hits depends on which file happened to be loaded.
 * That trap has cost real data. Here there is no `DATABASE_URL`: the only accepted
 * names are DATABASE_URL_DEV and DATABASE_URL_PROD, each naming its target in the
 * variable itself, and the target is additionally chosen by an explicit --target flag.
 * A bare DATABASE_URL in the environment is ignored -- and if it is the ONLY thing set,
 * this script fails with an explanation rather than guessing.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { fileURLToPath } from "url";
import { normalizeUnit, toMg } from "../schema/normalize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

/** Load env via lib/env.js when the rest of the repo provides it, else dotenv, else process.env. */
async function loadEnv() {
  try {
    const mod = await import("../lib/env.js");
    const e = mod && (mod.env || mod.default || mod);
    if (e && typeof e === "object" && (e.DATABASE_URL_DEV || e.DATABASE_URL_PROD || e.PATH)) return e;
  } catch {
    /* lib/env.js not present yet -- fall through */
  }
  try {
    const dotenv = await import("dotenv");
    (dotenv.default || dotenv).config({ path: path.join(__dirname, "..", ".env") });
  } catch {
    /* dotenv not installed -- process.env only */
  }
  return process.env;
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { snapshot: null, target: "dev", yesProd: false, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--snapshot") out.snapshot = argv[++i];
    else if (a.startsWith("--snapshot=")) out.snapshot = a.slice(11);
    else if (a === "--target") out.target = argv[++i];
    else if (a.startsWith("--target=")) out.target = a.slice(9);
    else if (a === "--yes-prod") out.yesProd = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.snapshot) throw new Error("--snapshot <path> is required");
  if (out.target !== "dev" && out.target !== "prod") {
    throw new Error(`--target must be "dev" or "prod", got ${JSON.stringify(out.target)}`);
  }
  if (out.target === "prod" && !out.yesProd) {
    throw new Error("refusing to import to prod without --yes-prod");
  }
  return out;
}

function connectionStringFor(target, env) {
  const name = target === "prod" ? "DATABASE_URL_PROD" : "DATABASE_URL_DEV";
  const url = env[name];
  if (!url) {
    const hint = env.DATABASE_URL
      ? ` A bare DATABASE_URL is set and is deliberately ignored: copy it into ${name} once you have confirmed which database it points at.`
      : "";
    throw new Error(`${name} is not set.${hint}`);
  }
  return { name, url };
}

/** Postgres URL with the password replaced, safe to print. */
function maskUrl(url) {
  return String(url).replace(/^([a-z]+:\/\/[^:/@]+):[^@]*@/i, "$1:<pw>@");
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable host>";
  }
}

// ---------------------------------------------------------------------------
// snapshot + sha256 sidecar
// ---------------------------------------------------------------------------

function sha256OfFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Sidecar may be bare hex or `<hex>  <filename>` (sha256sum output). */
function readSidecar(file) {
  const sidecar = `${file}.sha256`;
  if (!fs.existsSync(sidecar)) throw new Error(`missing sha256 sidecar: ${sidecar}`);
  const m = fs.readFileSync(sidecar, "utf8").trim().match(/\b([0-9a-f]{64})\b/i);
  if (!m) throw new Error(`sidecar ${sidecar} contains no sha256 digest`);
  return m[1].toLowerCase();
}

function verifySha(file) {
  const expected = readSidecar(file);
  const actual = sha256OfFile(file);
  if (actual !== expected) {
    throw new Error(
      `sha256 mismatch for ${path.basename(file)}: sidecar says ${expected}, file is ${actual}. ` +
        `Refusing to touch the database.`
    );
  }
  return actual;
}

function versionFromPath(file) {
  const m = path.basename(file).match(/catalog-v(\d+)\.json$/);
  return m ? Number(m[1]) : null;
}

/** Accepts a bare array, {products:[...]}, {rows:[...]}, or a key->row object. */
function loadSnapshot(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  let products;
  let version = versionFromPath(file);
  if (Array.isArray(raw)) {
    products = raw;
  } else if (raw && Array.isArray(raw.products)) {
    products = raw.products;
    if (raw.version != null) version = Number(raw.version);
  } else if (raw && Array.isArray(raw.rows)) {
    products = raw.rows;
    if (raw.version != null) version = Number(raw.version);
  } else if (raw && typeof raw === "object") {
    products = Object.values(raw);
  } else {
    throw new Error(`snapshot ${file} is not an array or an object of rows`);
  }
  if (!Number.isInteger(version)) {
    throw new Error(
      `cannot determine snapshot version: name the file catalog-v<N>.json or set a top-level "version"`
    );
  }
  if (!products.length) throw new Error(`snapshot ${file} has no products`);
  const bad = products.findIndex((p) => !p || !p.key);
  if (bad !== -1) throw new Error(`snapshot row ${bad} has no "key"`);
  const seen = new Set();
  for (const p of products) {
    if (seen.has(p.key)) throw new Error(`duplicate key in snapshot: ${p.key}`);
    seen.add(p.key);
  }
  return { version, products };
}

// ---------------------------------------------------------------------------
// row shaping
// ---------------------------------------------------------------------------

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined) return v;
  return null;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v) {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

function jsonb(v, fallback) {
  return JSON.stringify(v === undefined || v === null ? fallback : v);
}

function externalIdOf(p) {
  if (p.asin) return String(p.asin);
  if (p.id !== undefined && p.id !== null) return String(p.id);
  const i = String(p.key).indexOf("__");
  return i === -1 ? String(p.key) : String(p.key).slice(i + 2);
}

function sourceOf(p) {
  if (p.source) return p.source;
  if (p.store === "amazon.in" || p.asin) return "amazon";
  return "shopify";
}

/** Product column values, in the order used by the upsert statement. */
function productValues(p, snapshotVersion) {
  return [
    p.key,
    sourceOf(p),
    p.store ?? null,
    externalIdOf(p),
    p.brand ?? null,
    p.productName ?? null,
    p.title ?? null,
    p.formFactor ?? null,
    p.isFoodForm === true,
    p.pack ?? null,
    p.servingSize == null ? null : String(p.servingSize),
    num(p.servingsPerContainer),
    p.netQuantity == null ? null : String(p.netQuantity),
    int(p.unitsInContainer),
    p.doseDirections ?? null,
    p.imageUrl ?? null,
    jsonb(p.labelImages, []),
    p.verification ?? null,
    num(p.confidence),
    jsonb(firstDefined(p.checks), {}),
    jsonb(claimsOf(p), {}),
    jsonb(packMarksOf(p), {}),
    jsonb(firstDefined(p.allergens), {}),
    jsonb(firstDefined(p.fssaiLicences, p.fssaiLicenses), []),
    p.descriptionText ?? null,
    p.notes ?? null,
    int(firstDefined(p.schemaVersion)) ?? 1,
    snapshotVersion,
    p.extractedAt ?? null,
    p.model ?? null,
  ];
}

/** New record has `claims`; legacy clean.json rows have four claimed* arrays. */
function claimsOf(p) {
  if (p.claims !== undefined && p.claims !== null) return p.claims;
  const legacy = {
    testing: p.claimedTesting ?? null,
    purity: p.claimedPurity ?? null,
    facility: p.claimedFacility ?? null,
    diet: p.claimedDiet ?? null,
    ingredientLevel: p.ingredientLevelCertifications ?? null,
    keywords: p.keywordClaims ?? null,
  };
  return Object.values(legacy).some((v) => v !== null) ? legacy : {};
}

/** New record has `packMarks`; legacy rows have pack*Marks + illegibleBadges. */
function packMarksOf(p) {
  if (p.packMarks !== undefined && p.packMarks !== null) return p.packMarks;
  const legacy = {
    testingMarks: p.packTestingMarks ?? null,
    certificationMarks: p.packCertificationMarks ?? null,
    dietMarks: p.packDietMarks ?? null,
    illegibleBadgeCount: p.illegibleBadges ?? null,
  };
  return Object.values(legacy).some((v) => v !== null) ? legacy : {};
}

function ingredientRows(p) {
  const list = Array.isArray(p.ingredients) ? p.ingredients : [];
  return list.map((r, i) => [
    p.key,
    i,
    r.role ?? null,
    r.printedName ?? null,
    r.canonical ?? null,
    num(r.amount),
    r.unit == null ? null : String(r.unit),
    normalizeUnit(r.unit),
    toMg(r.amount, r.unit),
    r.amountBasis ?? null,
    r.isPartOfBlend === true,
    r.blendName ?? null,
    r.source ?? null,
    r.flagged === true,
  ]);
}

/** Offers: the new record's `offers[]`, else synthesised from legacy price fields. */
function offerRows(p) {
  const list = Array.isArray(p.offers) && p.offers.length ? p.offers : legacyOffers(p);
  return list.map((o) => [
    p.key,
    o.source ?? sourceOf(p),
    o.store ?? p.store ?? null,
    o.url ?? p.url ?? null,
    num(firstDefined(o.price, o.priceMin)),
    num(firstDefined(o.priceMax, o.price_max)),
    num(o.listPrice),
    o.currency ?? p.currency ?? "INR",
    o.inStock === undefined ? null : o.inStock,
    num(firstDefined(o.rating, p.rating)),
    int(firstDefined(o.reviewCount, p.reviewCount)),
  ]);
}

function legacyOffers(p) {
  const offers = [];
  if (p.url || p.priceMin != null) {
    offers.push({
      source: sourceOf(p),
      store: p.store,
      url: p.url,
      price: p.priceMin,
      priceMax: p.priceMax,
      listPrice: p.listPrice,
      currency: p.currency,
      inStock: p.inStock,
      rating: p.rating,
      reviewCount: p.reviewCount,
    });
  }
  if (p.amazonOffer && p.amazonOffer.url) {
    offers.push({
      source: "amazon",
      store: "amazon.in",
      url: p.amazonOffer.url,
      price: p.amazonOffer.price,
      priceMax: p.amazonOffer.price,
      listPrice: p.amazonOffer.listPrice,
      currency: "INR",
      inStock: p.amazonOffer.inStock,
    });
  }
  return offers;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const PRODUCT_COLS = [
  "key", "source", "store", "external_id", "brand", "product_name", "title", "form_factor",
  "is_food_form", "pack", "serving_size", "servings_per_container", "net_quantity",
  "units_in_container", "dose_directions", "image_url", "label_images", "verification",
  "confidence", "checks", "claims", "pack_marks", "allergens", "fssai_licences",
  "description_text", "notes", "schema_version", "snapshot_version", "extracted_at", "model",
];

const UPSERT_PRODUCT = (() => {
  const ph = PRODUCT_COLS.map((_, i) => `$${i + 1}`).join(", ");
  const set = PRODUCT_COLS.filter((c) => c !== "key")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(",\n    ");
  return (
    `INSERT INTO supplement_products (${PRODUCT_COLS.join(", ")}, active)\n` +
    `VALUES (${ph}, true)\n` +
    `ON CONFLICT (key) DO UPDATE SET\n    ${set},\n    active = true,\n    updated_at = now()`
  );
})();

const DELETE_INGREDIENTS = `DELETE FROM product_ingredients WHERE product_key = $1`;
const DELETE_OFFERS = `DELETE FROM product_offers WHERE product_key = $1`;

const INSERT_INGREDIENT =
  `INSERT INTO product_ingredients (product_key, position, role, printed_name, canonical, ` +
  `amount, unit, unit_norm, amount_mg, amount_basis, is_part_of_blend, blend_name, source, flagged) ` +
  `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`;

const INSERT_OFFER =
  `INSERT INTO product_offers (product_key, source, store, url, price, price_max, list_price, ` +
  `currency, in_stock, rating, review_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;

// Scoped by snapshot_version: every key present in this snapshot was just stamped with it.
const DEACTIVATE_MISSING =
  `UPDATE supplement_products SET active = false, updated_at = now() ` +
  `WHERE active = true AND (snapshot_version IS NULL OR snapshot_version <> $1)`;

const SELECT_SNAPSHOT = `SELECT version, sha256, row_count FROM catalog_snapshots WHERE version = $1`;

const INSERT_SNAPSHOT =
  `INSERT INTO catalog_snapshots (version, sha256, row_count, imported_by) VALUES ($1,$2,$3,$4) ` +
  `ON CONFLICT (version) DO UPDATE SET sha256 = EXCLUDED.sha256, ` +
  `row_count = EXCLUDED.row_count, imported_at = now(), imported_by = EXCLUDED.imported_by`;

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string[]} argv
 * @param {object} deps  {client, env, log, sleep, importedBy, batchSize}
 *   client: an object with .query(sql, params) -- injected by tests, never a real DB there.
 */
async function runImport(argv, deps = {}) {
  const args = parseArgs(argv);
  const env = deps.env || (await loadEnv());
  const log = deps.log || console.log;
  const sleep = deps.sleep || defaultSleep;
  const batchSize = deps.batchSize || BATCH_SIZE;
  const file = path.resolve(args.snapshot);

  const sha = verifySha(file);
  const { version, products } = loadSnapshot(file);
  log(`snapshot v${version}: ${products.length} products, sha256 ${sha.slice(0, 12)}…`);

  if (args.dryRun) {
    const ings = products.reduce((n, p) => n + (p.ingredients ? p.ingredients.length : 0), 0);
    log(`dry run: would upsert ${products.length} products, ${ings} ingredient rows, target ${args.target}. No connection opened.`);
    return { version, sha, products: products.length, dryRun: true, imported: false };
  }

  // With no injected client the connection string must resolve, or we stop here.
  // With one (tests), resolve it only if it happens to be configured.
  let name = "(injected client)";
  let url = null;
  if (!deps.client) {
    ({ name, url } = connectionStringFor(args.target, env));
  } else {
    try {
      ({ name, url } = connectionStringFor(args.target, env));
    } catch {
      /* injected client needs no URL */
    }
  }

  if (args.target === "prod") {
    log(`TARGET PROD via ${name}`);
    log(`  host: ${url ? hostOf(url) : "(injected client)"}`);
    log(`  url:  ${url ? maskUrl(url) : "(injected client)"}`);
    log(`  starting in 5s, ctrl-C to abort`);
    await sleep(5000);
  }

  const client = deps.client || (await connectPg(url));
  const importedBy = deps.importedBy || `${os.userInfo().username}@${os.hostname()}`;

  try {
    const existing = await client.query(SELECT_SNAPSHOT, [version]);
    if (existing && existing.rows && existing.rows.length && !args.force) {
      throw new Error(
        `snapshot version ${version} is already recorded in catalog_snapshots ` +
          `(imported sha ${String(existing.rows[0].sha256).slice(0, 12)}…). Pass --force to re-import.`
      );
    }

    let done = 0;
    for (const batch of chunk(products, batchSize)) {
      await client.query("BEGIN");
      try {
        for (const p of batch) {
          await client.query(UPSERT_PRODUCT, productValues(p, version));
          // Rows are replaced wholesale per product: an ingredient list is only
          // meaningful as a set, and both deletes are scoped by product_key.
          await client.query(DELETE_INGREDIENTS, [p.key]);
          for (const row of ingredientRows(p)) await client.query(INSERT_INGREDIENT, row);
          await client.query(DELETE_OFFERS, [p.key]);
          for (const row of offerRows(p)) await client.query(INSERT_OFFER, row);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      done += batch.length;
      log(`  upserted ${done}/${products.length}`);
    }

    await client.query("BEGIN");
    try {
      // Products absent from this snapshot are retired, never deleted: a user's
      // stack may still reference the key and history must stay readable.
      const deact = await client.query(DEACTIVATE_MISSING, [version]);
      await client.query(INSERT_SNAPSHOT, [version, sha, products.length, importedBy]);
      await client.query("COMMIT");
      const n = deact && typeof deact.rowCount === "number" ? deact.rowCount : "?";
      log(`deactivated ${n} product(s) absent from v${version}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    log(`imported snapshot v${version} into ${args.target}`);
    return { version, sha, products: products.length, dryRun: false, imported: true };
  } finally {
    if (!deps.client && client.end) await client.end();
  }
}

async function connectPg(url) {
  // Required lazily so the test suite (and --dry-run) work without pg installed.
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

export {
  runImport,
  parseArgs,
  loadSnapshot,
  verifySha,
  sha256OfFile,
  readSidecar,
  maskUrl,
  hostOf,
  connectionStringFor,
  productValues,
  ingredientRows,
  offerRows,
  PRODUCT_COLS,
  UPSERT_PRODUCT,
  DELETE_INGREDIENTS,
  DELETE_OFFERS,
  DEACTIVATE_MISSING,
  INSERT_SNAPSHOT,
  SELECT_SNAPSHOT,
  BATCH_SIZE,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runImport(process.argv.slice(2)).catch((err) => {
    console.error(`import failed: ${err.message}`);
    process.exit(1);
  });
}
