// Brand naming, from config/brands.json only. Legacy's brandOf() fell back to a haystack of
// vendor + label brand + title, which produced brand names like "CosMix CosMix Bring Me Bliss"
// for any store missing from STORE_BRAND (issue 41). Here a missing store is a loud null.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.js";

const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config/brands.json"), "utf8"));
export const BRANDS = CONFIG.brands;

export const byStore = new Map(BRANDS.filter((b) => b.shopify).map((b) => [b.shopify, b]));
export const shopifyStores = () => BRANDS.filter((b) => b.shopify).map((b) => b.shopify);
export const amazonBrands = () => BRANDS.filter((b) => b.amazonBrand);

const byAmazonFile = new Map();
for (const b of BRANDS) for (const f of b.amazonFiles || []) byAmazonFile.set(f, b);

export const brandBySlug = (slug) => byAmazonFile.get(slug) || BRANDS.find((b) => slugify(b.brand) === slug) || null;
export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Match tokens for a raw Amazon pull file. Keyword pulls are named after the query
// ("boldfit-whey-protein"), so the file's own brand entry supplies the tokens.
export function aliasesForAmazonFile(slug) {
  const b = brandBySlug(slug);
  if (b) return b.aliases || [slugify(b.brand).replace(/-/g, " ")];
  return [slug.replace(/-/g, " ")];
}

// Genuine separate brands sold inside another brand's store, matched on the row's own text.
const subBrands = BRANDS.filter((b) => b.subBrandOnly);
function subBrandOf(haystack) {
  const h = String(haystack || "").toLowerCase();
  for (const b of subBrands) if ((b.aliases || []).some((a) => h.includes(a))) return b.brand;
  return null;
}

/**
 * Canonical brand for a Shopify row. `haystack` (vendor + label brand + title) is used ONLY
 * to spot a sub-brand; it is never a fallback, or the brand becomes the product title.
 */
export function brandForShopify({ store, haystack, vendor, labelBrand }) {
  const sub = subBrandOf(haystack);
  if (sub) return sub;
  const b = byStore.get(store);
  if (b) return b.brand;
  const v = (vendor || "").trim();
  const l = (labelBrand || "").trim();
  return v || l || null;
}

/** Canonical brand for an Amazon row, from the pull file it came out of. */
export function brandForAmazon({ pullSlug, amazonBrandString, labelBrand }) {
  const b = brandBySlug(pullSlug);
  return b ? b.brand : (amazonBrandString || "").trim() || (labelBrand || "").trim() || null;
}

// Stores/brands configured with a note that they legitimately yield nothing: a zero count for
// these is expected, not a pipeline bug worth re-investigating (issues 19, 57, 58).
export const expectedEmpty = () => BRANDS.filter((b) => /0 supplements|not supplements/.test(b.note || "")).map((b) => b.brand);
