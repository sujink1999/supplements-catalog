// node --test test/import.test.js
//
// Nothing here connects to a database. Every test injects a fake client that only
// records the SQL it is handed, so the suite is safe to run anywhere.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import * as imp from "../stages/import.js";
import { normalizeUnit, toMg, normalizeAmount } from "../schema/normalize.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Records every (sql, params). `existingVersions` drives the catalog_snapshots lookup. */
function fakeClient({ existingVersions = [] } = {}) {
  const calls = [];
  return {
    calls,
    sql: () => calls.map((c) => c.sql),
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === imp.SELECT_SNAPSHOT) {
        const v = params[0];
        return existingVersions.includes(v)
          ? { rows: [{ version: v, sha256: "a".repeat(64), row_count: 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const PRODUCT = {
  key: "aceblend.com__1234",
  store: "aceblend.com",
  id: 1234,
  url: "https://aceblend.com/products/mix-of-4",
  title: "Mix of 4",
  brand: "Ace Blend",
  productName: "Mix of 4",
  formFactor: "powder",
  isFoodForm: false,
  pack: "single",
  servingSize: "30 g",
  servingsPerContainer: 30,
  netQuantity: "900 g",
  unitsInContainer: null,
  doseDirections: "One scoop daily",
  imageUrl: "https://img/1.jpg",
  labelImages: ["https://img/label.jpg"],
  verification: "label_read",
  confidence: 0.94,
  priceMin: 345,
  priceMax: 345,
  currency: "INR",
  rating: 4.5,
  reviewCount: 12,
  ingredients: [
    { role: "macro", printedName: "Energy (Kcal)", canonical: "energy", amount: 127.57, unit: "kcal", amountBasis: "unknown", isPartOfBlend: false, source: "label_image" },
    { role: "active", printedName: "Vitamin D3", canonical: "vitamin d3", amount: 600, unit: "IU", amountBasis: "unknown", isPartOfBlend: false, source: "label_image" },
    { role: "active", printedName: "Magnesium", canonical: " Magnesium ", amount: 0.2, unit: "g", amountBasis: "elemental", isPartOfBlend: true, blendName: "Mineral blend", source: "label_image" },
  ],
  allergens: { contains: [], mayContainTraces: [], freeFrom: ["Gluten"], statement: null },
  fssaiLicences: [{ number: "10019022009084", role: "manufactured_by" }],
  descriptionText: "blah",
  notes: null,
  extractedAt: "2026-09-01T00:00:00.000Z",
  model: "gpt-6-luna",
};

const PRODUCT_2 = { ...PRODUCT, key: "aceblend.com__5678", id: 5678, ingredients: [] };

/** Writes catalog-v<N>.json + a sidecar; pass badSha to make the sidecar wrong. */
function writeSnapshot(products, version = 7, { badSha = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supcat-"));
  const file = path.join(dir, `catalog-v${version}.json`);
  const body = JSON.stringify(products, null, 2);
  fs.writeFileSync(file, body);
  const digest = badSha
    ? "0".repeat(64)
    : crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(`${file}.sha256`, `${digest}  catalog-v${version}.json\n`);
  return file;
}

const ENV = { DATABASE_URL_DEV: "postgres://u:secret@localhost:5432/supcat_dev", DATABASE_URL_PROD: "postgres://u:secret@prod.example.neon.tech/supcat" };
const quiet = () => {};

// ---------------------------------------------------------------------------
// sha256 sidecar
// ---------------------------------------------------------------------------

test("sha mismatch aborts before any query is issued", async () => {
  const file = writeSnapshot([PRODUCT], 7, { badSha: true });
  const client = fakeClient();
  await assert.rejects(
    () => imp.runImport(["--snapshot", file], { client, env: ENV, log: quiet }),
    /sha256 mismatch/
  );
  assert.equal(client.calls.length, 0, "no SQL may be issued when the sha does not match");
});

test("a missing sidecar aborts", async () => {
  const file = writeSnapshot([PRODUCT], 7);
  fs.unlinkSync(`${file}.sha256`);
  const client = fakeClient();
  await assert.rejects(
    () => imp.runImport(["--snapshot", file], { client, env: ENV, log: quiet }),
    /missing sha256 sidecar/
  );
  assert.equal(client.calls.length, 0);
});

test("editing the snapshot after the sidecar was written aborts", () => {
  const file = writeSnapshot([PRODUCT], 7);
  fs.appendFileSync(file, " ");
  assert.throws(() => imp.verifySha(file), /sha256 mismatch/);
});

// ---------------------------------------------------------------------------
// prod guard
// ---------------------------------------------------------------------------

test("--target prod without --yes-prod aborts, and issues no SQL", async () => {
  const file = writeSnapshot([PRODUCT], 7);
  const client = fakeClient();
  await assert.rejects(
    () => imp.runImport(["--snapshot", file, "--target", "prod"], { client, env: ENV, log: quiet }),
    /without --yes-prod/
  );
  assert.equal(client.calls.length, 0);
  assert.throws(() => imp.parseArgs(["--snapshot", "x.json", "--target", "prod"]), /--yes-prod/);
});

test("--target prod with --yes-prod prints the masked host and waits 5s", async () => {
  const file = writeSnapshot([PRODUCT], 7);
  const client = fakeClient();
  const lines = [];
  let slept = 0;
  await imp.runImport(["--snapshot", file, "--target", "prod", "--yes-prod"], {
    client,
    env: ENV,
    log: (l) => lines.push(String(l)),
    sleep: async (ms) => { slept += ms; },
  });
  const out = lines.join("\n");
  assert.match(out, /TARGET PROD/);
  assert.match(out, /prod\.example\.neon\.tech/);
  assert.match(out, /<pw>/);
  assert.equal(out.includes("secret"), false, "the password must never be printed");
  assert.equal(slept, 5000);
});

test("dev target neither prints a prod banner nor sleeps", async () => {
  const file = writeSnapshot([PRODUCT], 7);
  const lines = [];
  let slept = 0;
  await imp.runImport(["--snapshot", file], {
    client: fakeClient(), env: ENV, log: (l) => lines.push(String(l)), sleep: async (ms) => { slept += ms; },
  });
  assert.equal(lines.join("\n").includes("TARGET PROD"), false);
  assert.equal(slept, 0);
});

test("an unknown --target is rejected", () => {
  assert.throws(() => imp.parseArgs(["--snapshot", "x.json", "--target", "staging"]), /must be "dev" or "prod"/);
});

test("maskUrl hides the password but keeps the host", () => {
  assert.equal(
    imp.maskUrl("postgresql://neondb_owner:npg_AbC123@ep-x.ap-southeast-1.aws.neon.tech/db"),
    "postgresql://neondb_owner:<pw>@ep-x.ap-southeast-1.aws.neon.tech/db"
  );
});

test("a bare DATABASE_URL is ignored and named in the error", () => {
  assert.throws(
    () => imp.connectionStringFor("dev", { DATABASE_URL: "postgres://prod/oops" }),
    /DATABASE_URL_DEV is not set.*bare DATABASE_URL is set and is deliberately ignored/s
  );
});

// ---------------------------------------------------------------------------
// no unscoped mutation, ever
// ---------------------------------------------------------------------------

test("every DELETE and UPDATE issued is scoped by a WHERE clause", async () => {
  const file = writeSnapshot([PRODUCT, PRODUCT_2], 7);
  const client = fakeClient();
  await imp.runImport(["--snapshot", file], { client, env: ENV, log: quiet });

  const mutations = client.sql().filter((s) => /^\s*(DELETE|UPDATE|TRUNCATE|DROP)\b/i.test(s));
  assert.ok(mutations.length > 0);
  for (const sql of mutations) {
    assert.match(sql, /\bWHERE\b/i, `unscoped mutation: ${sql}`);
    assert.doesNotMatch(sql, /^\s*(TRUNCATE|DROP)\b/i, `destructive statement: ${sql}`);
  }
  // Row deletes are scoped by product_key specifically.
  for (const sql of mutations.filter((s) => /^\s*DELETE/i.test(s))) {
    assert.match(sql, /WHERE product_key = \$1/);
  }
  // The only UPDATE is the retire pass, and it is scoped by snapshot_version.
  const updates = mutations.filter((s) => /^\s*UPDATE/i.test(s));
  assert.equal(updates.length, 1);
  assert.match(updates[0], /WHERE active = true AND \(snapshot_version IS NULL OR snapshot_version <> \$1\)/);
  assert.match(updates[0], /SET active = false/);
});

test("products missing from the snapshot are deactivated, never deleted", async () => {
  const file = writeSnapshot([PRODUCT], 7);
  const client = fakeClient();
  await imp.runImport(["--snapshot", file], { client, env: ENV, log: quiet });
  const deletes = client.sql().filter((s) => /^\s*DELETE/i.test(s));
  for (const sql of deletes) assert.doesNotMatch(sql, /FROM supplement_products/i);
});

test("each batch is its own transaction and every BEGIN is closed", async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ ...PRODUCT, key: `s__${i}`, id: i }));
  const file = writeSnapshot(many, 7);
  const client = fakeClient();
  await imp.runImport(["--snapshot", file], { client, env: ENV, log: quiet, batchSize: 2 });
  const sql = client.sql();
  const begins = sql.filter((s) => s === "BEGIN").length;
  const commits = sql.filter((s) => s === "COMMIT").length;
  assert.equal(begins, 4, "3 product batches of size 2 plus the snapshot/retire batch");
  assert.equal(commits, begins);
  assert.equal(sql.filter((s) => s === "ROLLBACK").length, 0);
  // The snapshot ledger row is written inside a transaction, after the products.
  assert.ok(sql.lastIndexOf(imp.INSERT_SNAPSHOT) > sql.lastIndexOf(imp.UPSERT_PRODUCT));
});

test("a failing statement rolls its batch back", async () => {
  const file = writeSnapshot([PRODUCT], 7);
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push(sql);
      if (sql === imp.SELECT_SNAPSHOT) return { rows: [], rowCount: 0 };
      if (sql === imp.UPSERT_PRODUCT) throw new Error("boom");
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(() => imp.runImport(["--snapshot", file], { client, env: ENV, log: quiet }), /boom/);
  assert.ok(calls.includes("ROLLBACK"));
  assert.equal(calls.includes("COMMIT"), false);
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

test("the same snapshot twice produces byte-identical SQL, and re-import is refused without --force", async () => {
  const file = writeSnapshot([PRODUCT, PRODUCT_2], 7);

  const first = fakeClient();
  await imp.runImport(["--snapshot", file], { client: first, env: ENV, log: quiet, importedBy: "test" });

  // Second run against a DB that now has version 7 recorded: refused.
  const second = fakeClient({ existingVersions: [7] });
  await assert.rejects(
    () => imp.runImport(["--snapshot", file], { client: second, env: ENV, log: quiet, importedBy: "test" }),
    /already recorded in catalog_snapshots.*--force/s
  );
  assert.deepEqual(second.sql(), [imp.SELECT_SNAPSHOT], "refusal happens before any write");

  // Third run with --force: identical statements and identical parameters.
  const third = fakeClient({ existingVersions: [7] });
  await imp.runImport(["--snapshot", file, "--force"], { client: third, env: ENV, log: quiet, importedBy: "test" });
  assert.deepEqual(third.sql(), first.sql());
  assert.deepEqual(
    third.calls.map((c) => JSON.stringify(c.params)),
    first.calls.map((c) => JSON.stringify(c.params))
  );
  // Upsert, not insert: a re-run updates in place.
  assert.match(imp.UPSERT_PRODUCT, /ON CONFLICT \(key\) DO UPDATE SET/);
  assert.match(imp.INSERT_SNAPSHOT, /ON CONFLICT \(version\) DO UPDATE SET/);
});

test("--dry-run opens no connection and issues no SQL", async () => {
  const file = writeSnapshot([PRODUCT], 7);
  const client = fakeClient();
  const res = await imp.runImport(["--snapshot", file, "--dry-run"], { client, env: {}, log: quiet });
  assert.equal(client.calls.length, 0);
  assert.equal(res.imported, false);
  assert.equal(res.dryRun, true);
  assert.equal(res.products, 1);
});

// ---------------------------------------------------------------------------
// snapshot parsing and row shaping
// ---------------------------------------------------------------------------

test("snapshot version comes from the filename or a top-level version field", () => {
  const file = writeSnapshot([PRODUCT], 12);
  assert.equal(imp.loadSnapshot(file).version, 12);
});

test("duplicate keys in a snapshot are rejected", () => {
  const file = writeSnapshot([PRODUCT, { ...PRODUCT }], 7);
  assert.throws(() => imp.loadSnapshot(file), /duplicate key/);
});

test("a row without a key is rejected", () => {
  const file = writeSnapshot([{ title: "no key" }], 7);
  assert.throws(() => imp.loadSnapshot(file), /has no "key"/);
});

test("ingredient rows keep printed amount and unit, and convert only masses", () => {
  const rows = imp.ingredientRows(PRODUCT);
  const [key, position, role, printed, canonical, amount, unit, unitNorm, amountMg] = rows[0];
  assert.equal(key, PRODUCT.key);
  assert.equal(position, 0);
  assert.equal(role, "macro");
  assert.equal(printed, "Energy (Kcal)");
  assert.equal(canonical, "energy");
  assert.equal(amount, 127.57);
  assert.equal(unit, "kcal");
  assert.equal(unitNorm, "kcal");
  assert.equal(amountMg, null, "kcal is not a mass");

  assert.equal(rows[1][7], "IU");
  assert.equal(rows[1][8], null, "IU is not a mass");

  assert.equal(rows[2][7], "g");
  assert.equal(rows[2][8], 200, "0.2 g -> 200 mg");
  assert.equal(rows[2][10], true, "isPartOfBlend");
  assert.equal(rows[2][11], "Mineral blend");
  assert.deepEqual(rows.map((r) => r[1]), [0, 1, 2], "positions are the printed order");
});

test("legacy price fields become one offer row; amazonOffer becomes a second", () => {
  const rows = imp.offerRows(PRODUCT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][3], PRODUCT.url);
  assert.equal(rows[0][4], 345);
  assert.equal(rows[0][7], "INR");

  const withAmazon = { ...PRODUCT, amazonOffer: { asin: "B0X", url: "https://amazon.in/dp/B0X", price: 399, listPrice: 499, inStock: true } };
  const two = imp.offerRows(withAmazon);
  assert.equal(two.length, 2);
  assert.equal(two[1][1], "amazon");
  assert.equal(two[1][4], 399);

  // The new record's offers[] wins when present.
  const modern = { ...PRODUCT, offers: [{ source: "shopify", store: "s.com", url: "u", price: 10, priceMax: 12 }] };
  const one = imp.offerRows(modern);
  assert.equal(one.length, 1);
  assert.equal(one[0][4], 10);
  assert.equal(one[0][5], 12);
});

test("product values line up with the declared column list and stamp the snapshot version", () => {
  const vals = imp.productValues(PRODUCT, 7);
  assert.equal(vals.length, imp.PRODUCT_COLS.length);
  const at = (col) => vals[imp.PRODUCT_COLS.indexOf(col)];
  assert.equal(at("key"), PRODUCT.key);
  assert.equal(at("source"), "shopify");
  assert.equal(at("external_id"), "1234");
  assert.equal(at("snapshot_version"), 7);
  assert.equal(at("schema_version"), 1);
  assert.equal(at("is_food_form"), false);
  assert.equal(JSON.parse(at("label_images")).length, 1);
  assert.equal(JSON.parse(at("fssai_licences"))[0].role, "manufactured_by");
  assert.deepEqual(JSON.parse(at("checks")), {});
  // legacy claimed* arrays are folded into the claims jsonb
  const claims = JSON.parse(imp.productValues({ ...PRODUCT, claimedDiet: ["vegan"] }, 7)[imp.PRODUCT_COLS.indexOf("claims")]);
  assert.deepEqual(claims.diet, ["vegan"]);
});

test("an amazon row is detected as source amazon with the ASIN as external_id", () => {
  const row = { key: "amazon.in__B0ABC", store: "amazon.in", asin: "B0ABC", source: "amazon" };
  const vals = imp.productValues(row, 3);
  assert.equal(vals[imp.PRODUCT_COLS.indexOf("source")], "amazon");
  assert.equal(vals[imp.PRODUCT_COLS.indexOf("external_id")], "B0ABC");
});

// ---------------------------------------------------------------------------
// unit normalisation
// ---------------------------------------------------------------------------

test("normalizeUnit collapses the legacy unit mess", () => {
  const cases = {
    kcal: "kcal", Kcal: "kcal", KCAL: "kcal",
    g: "g", gm: "g", gms: "g", " G ": "g", grams: "g",
    mg: "mg", MG: "mg",
    mcg: "mcg", "µg": "mcg", ug: "mcg", "μg": "mcg", micrograms: "mcg",
    IU: "IU", "I.U.": "IU", "i.u.": "IU",
    "q.s.": "qs", "Q.S.": "qs", QS: "qs",
    "%": "pct",
    "billion CFU": "bn_cfu", "million CFU": "mn_cfu", CFU: "cfu",
    "billion CFU/g": "bn_cfu_per_g",
    ml: "ml", HUT: "hut",
    "mcg DFE": "mcg_dfe",
  };
  for (const [raw, want] of Object.entries(cases)) {
    assert.equal(normalizeUnit(raw), want, `${JSON.stringify(raw)} -> ${want}`);
  }
});

test("normalizeUnit folds the 'per' and '/' ratio spellings together", () => {
  assert.equal(normalizeUnit("g/100g protein"), normalizeUnit("g per 100 g protein"));
  assert.equal(normalizeUnit("g/100 g protein"), normalizeUnit("g per 100 g protein"));
  assert.equal(normalizeUnit("g/100 g protein"), "g_per_100g_protein");
  assert.equal(normalizeUnit("g per 30 g"), "g_per_30g");
  assert.equal(normalizeUnit("% per 100g"), "pct_per_100g");
});

test("a blank or absent unit normalises to null, an unknown one passes through", () => {
  assert.equal(normalizeUnit(null), null);
  assert.equal(normalizeUnit(undefined), null);
  assert.equal(normalizeUnit(""), null);
  assert.equal(normalizeUnit("   "), null);
  assert.equal(normalizeUnit("Wobbles"), "wobbles");
});

test("toMg converts g, mg, mcg and kg, and nothing else", () => {
  assert.equal(toMg(1, "g"), 1000);
  assert.equal(toMg(1, "gm"), 1000);
  assert.equal(toMg(500, "mg"), 500);
  assert.equal(toMg(400, "mcg"), 0.4);
  assert.equal(toMg(400, "µg"), 0.4);
  assert.equal(toMg(1, "kg"), 1e6);
  for (const u of ["%", "IU", "I.U.", "billion CFU", "CFU", "kcal", "Kcal", "ml", "q.s.", "g/100 g protein", "capsule", "HUT", null, ""]) {
    assert.equal(toMg(5, u), null, `${JSON.stringify(u)} must not get an amount_mg`);
  }
});

test("toMg returns null for a missing or non-numeric amount", () => {
  assert.equal(toMg(null, "mg"), null);
  assert.equal(toMg(undefined, "mg"), null);
  assert.equal(toMg("", "mg"), null);
  assert.equal(toMg("abc", "mg"), null);
  assert.equal(toMg("250", "mg"), 250, "a numeric string is still a number");
});

test("normalizeAmount returns both derived fields at once", () => {
  assert.deepEqual(normalizeAmount(2.5, "g"), { unitNorm: "g", amountMg: 2500 });
  assert.deepEqual(normalizeAmount(7, "%"), { unitNorm: "pct", amountMg: null });
});
