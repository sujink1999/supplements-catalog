// Stage 2: everything rule-based, BEFORE any paid call. Drops non-supplements, gear, food,
// topicals, off-brand leakage and rows with no photo, and assigns the canonical brand.
// Only bundle/multipack rejection needs the model, so that one waits for extraction.
// Out: data/filtered/<brand>.json  (kept rows, extractor-ready)  + .dropped.json (reasons)
import path from "node:path";
import { NON_SUPP, GEAR, FOOD, TOPICAL, NON_FORM } from "../config/rules.js";
import { brandBySlug, brandForShopify, brandForAmazon, slugify, aliasesForAmazonFile } from "../lib/brands.js";
import { dir, readJson, writeJson } from "../lib/store.js";
import { shopifyKey, amazonKey } from "../lib/keys.js";
import { stripHtml } from "../lib/text.js";

/** Why this raw row is not worth extracting, or null to keep it. */
export function dropReason(row, { aliases = null } = {}) {
  const title = row.title || "";
  if (aliases) {
    const hay = `${row.brand || ""} ${title}`.toLowerCase();
    if (!aliases.some((a) => hay.includes(a))) return "off_brand";
  }
  if (TOPICAL.test(title)) return "topical";
  if (GEAR.test(title) || NON_FORM.test(row.itemForm || "")) return "gear";
  if (FOOD.test(title)) return "food";
  if (NON_SUPP.test(title) || NON_SUPP.test(row.productType || "")) return "not_supplement";
  if (!(row.images || []).length) return "no_image";
  return null;
}

/** Shopify raw row -> extractor input row. */
export function toInputShopify(row, brand) {
  return {
    key: shopifyKey(row.store, row.id),
    source: "shopify",
    store: row.store,
    id: row.id,
    url: row.url,
    title: row.title,
    brand,
    vendor: row.vendor,
    productType: row.productType || "",
    tags: row.tags || [],
    bodyHtml: row.bodyHtml,
    variants: (row.variants || []).map((v) => ({ id: v.id, title: v.title, price: v.price, available: v.available, url: v.url })),
    images: (row.images || []).map((i) => ({ src: i.src, w: i.w, h: i.h })),
  };
}

/** Amazon raw row -> extractor input row. Amazon's own 1500px photos, A+ copy as description. */
export function toInputAmazon(row, brand) {
  const { images, features, description, ingredientsText, doseDirections, ...rest } = row;
  return {
    key: amazonKey(row.asin),
    source: "amazon",
    store: "amazon.in",
    id: row.asin,
    asin: row.asin,
    url: row.url,
    title: row.title,
    brand,
    vendor: row.brand || brand,
    productType: row.supplementType || "",
    tags: [],
    bodyHtml: [description, ingredientsText, doseDirections, ...(features || [])].filter(Boolean).join(" — "),
    variants: [{ title: row.unitCount || "default", price: row.price }],
    images: (images || []).slice(0, 12).map((u) => ({ src: u, w: 1500, h: 1500 })),
    // Amazon-only fields the finalizer carries across (rating, stock, declaration, ...).
    meta: { ...rest, description, ingredientsText, doseDirections, features },
  };
}

export function run({ brand, source, log = console.log }) {
  const entry = brandBySlug(slugify(brand));
  if (!entry) throw new Error(`unknown brand "${brand}" — add it to config/brands.json`);
  const src = source || (entry.shopify ? "shopify" : "amazon");
  const slug = slugify(entry.brand);
  const raw = readJson(path.join(dir("raw", src), `${slug}.json`), null);
  if (!raw) throw new Error(`no raw pull at data/raw/${src}/${slug}.json — run fetch first`);

  const aliases = src === "amazon" ? aliasesForAmazonFile(slug) : null;
  const kept = [];
  const dropped = [];
  const seen = new Set();
  const why = {};
  for (const row of raw) {
    const id = src === "amazon" ? row.asin : row.id;
    let reason = dropReason(row, { aliases });
    if (!reason && id != null && seen.has(String(id))) reason = "duplicate";
    if (reason) {
      why[reason] = (why[reason] || 0) + 1;
      dropped.push({ id, title: row.title, reason });
      continue;
    }
    seen.add(String(id));
    const b =
      src === "amazon"
        ? brandForAmazon({ pullSlug: slug, amazonBrandString: row.brand })
        : brandForShopify({ store: row.store, haystack: `${row.vendor || ""} ${row.title || ""}`, vendor: row.vendor });
    kept.push(src === "amazon" ? toInputAmazon(row, b) : toInputShopify(row, b));
  }

  const outDir = dir("filtered");
  writeJson(path.join(outDir, `${slug}.json`), kept);
  writeJson(path.join(outDir, `${slug}.dropped.json`), dropped);
  log(`${entry.brand}: ${kept.length} of ${raw.length} kept for extraction, dropped ${dropped.length} ${JSON.stringify(why)}`);
  // A brand configured as legitimately supplement-free is not a bug worth re-investigating.
  if (!kept.length && entry.note) log(`  (expected: ${entry.note})`);
  return { kept, dropped, why };
}

export { stripHtml };
