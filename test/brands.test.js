import test from "node:test";
import assert from "node:assert/strict";
import { BRANDS, brandForShopify, brandForAmazon, brandBySlug, aliasesForAmazonFile, shopifyStores, slugify } from "../lib/brands.js";
import { budget, usdFor, totals } from "../lib/ledger.js";

test("config/brands.json is the union of the four legacy maps", () => {
  // 33 Shopify stores (fetch_shopify.js STORES == clean.js STORE_BRAND),
  // 6 sub-brands (clean.js SUB_BRANDS), 17 Amazon-only (amazon_clean.js BRAND_NAME minus
  // Boldfit, which is also a store).
  assert.equal(shopifyStores().length, 33);
  assert.equal(BRANDS.filter((b) => b.subBrandOnly).length, 6);
  assert.equal(BRANDS.filter((b) => b.amazonBrand && !b.shopify).length, 17);
  assert.equal(BRANDS.length, 56);
  // No duplicate brand name, and no duplicate store.
  assert.equal(new Set(BRANDS.map((b) => b.brand)).size, BRANDS.length);
  assert.equal(new Set(shopifyStores()).size, 33);
});

test("every brand has at least one way to be found", () => {
  for (const b of BRANDS) {
    assert.ok(b.brand, "brand name required");
    assert.ok(b.shopify || b.amazonBrand || b.subBrandOnly, `${b.brand} has no source`);
    assert.ok((b.aliases || []).length, `${b.brand} has no aliases`);
  }
});

test("brandForShopify uses the store map, never the title haystack as a fallback", () => {
  assert.equal(brandForShopify({ store: "cosmix.in", haystack: "CosMix CosMix Bring Me Bliss", vendor: "CosMix" }), "Cosmix");
  // Issue 41: an unknown store must not yield a brand made of the product title.
  assert.equal(brandForShopify({ store: "unknown.example", haystack: "Some Brand Some Product Name", vendor: "" }), null);
  assert.equal(brandForShopify({ store: "unknown.example", haystack: "x", vendor: "Real Vendor" }), "Real Vendor");
});

test("a sub-brand inside another brand's store wins over the store brand", () => {
  assert.equal(brandForShopify({ store: "healthyhey.com", haystack: "HealthyHey Sports Creatine", vendor: "HealthyHey" }), "HealthyHey Sports");
  assert.equal(brandForShopify({ store: "healthyhey.com", haystack: "HealthyHey Vitamin D3", vendor: "HealthyHey" }), "HealthyHey Nutrition");
  assert.equal(brandForShopify({ store: "bigmusclesnutrition.com", haystack: "BM Wellness Multivitamin", vendor: "" }), "BM Wellness");
});

test("brandForAmazon settles the shouty Amazon strings on one name", () => {
  assert.equal(brandForAmazon({ pullSlug: "plix-the-plant-fix", amazonBrandString: "PLIX - THE PLANT FIX" }), "Plix");
  assert.equal(brandForAmazon({ pullSlug: "be-vitamin", amazonBrandString: "Be." }), "Be Wellness");
  assert.equal(brandForAmazon({ pullSlug: "boldfit-whey-protein", amazonBrandString: "BOLDFIT" }), "Boldfit");
  assert.equal(brandForAmazon({ pullSlug: "brand-we-never-configured", amazonBrandString: "Whatever" }), "Whatever");
});

test("aliasesForAmazonFile covers keyword pulls and unconfigured files", () => {
  assert.deepEqual(aliasesForAmazonFile("plix-the-plant-fix"), ["plix", "plant fix"]);
  assert.deepEqual(aliasesForAmazonFile("boldfit-creatine-monohydrate"), ["boldfit"]);
  assert.deepEqual(aliasesForAmazonFile("some-new-brand"), ["some new brand"]);
});

test("brandBySlug finds a brand by its own name as well as by a pull file", () => {
  assert.equal(brandBySlug("ace-blend").brand, "Ace Blend");
  assert.equal(brandBySlug(slugify("Vlado's Himalayan Organics")).brand, "Vlado's Himalayan Organics");
  assert.equal(brandBySlug("hk-vitals").brand, "HK Vitals");
  assert.equal(brandBySlug("nope"), null);
});

test("ledger prices and the spend cap", () => {
  assert.equal(usdFor("gpt-6-luna", 1e6, 0), 0.1);
  assert.equal(usdFor("gpt-6-luna", 0, 1e6), 0.5);
  assert.equal(usdFor("no-such-model", 1e6, 1e6), null);

  const b = budget(0.01);
  b.add(0.006);
  assert.equal(b.spent, 0.006);
  assert.throws(() => b.add(0.006), (e) => e.budgetExceeded === true);
  // No cap means no throw.
  const free = budget(null);
  free.add(100);
  assert.equal(free.spent, 100);
});

test("ledger totals sum per stage and count unpriced calls", () => {
  const t = totals([
    { stage: "extract", tokensIn: 100, tokensOut: 10, usd: 0.001 },
    { stage: "extract", tokensIn: 100, tokensOut: 10, usd: 0.002 },
    { stage: "check", tokensIn: 50, tokensOut: 5, usd: null },
  ]);
  assert.equal(t.calls, 3);
  assert.equal(t.tokensIn, 250);
  assert.equal(t.unpriced, 1);
  assert.ok(Math.abs(t.usd - 0.003) < 1e-9);
  assert.equal(t.byStage.extract.calls, 2);
});
