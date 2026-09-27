#!/usr/bin/env node
// Pull full catalogs from Indian D2C Shopify stores via the public /products.json.
// Output: scripts/e2e/out/products/shopify/<store>.json (gitignored). No DB, no LLM.
// Usage: node scripts/supplements/products/fetch_shopify.js [store ...]
const fs = require("fs");
const path = require("path");

const STORES = [
  "mycf.in", "boldfit.com", "healthyhey.com", "beastlife.in", "cureveda.com",
  "inlifehealthcare.com", "wellbeingnutrition.com", "steadfastnutrition.in",
  "in.fastandup.com", "miduty.in", "thehimalayanorganics.in", "thesirona.com",
  "unived.com", "oziva.in", "bigmusclesnutrition.com", "naturyz.in", "neuherbs.com",
  "setu.in", "zeroharm.in", "originnutrition.in", "nakpro.com", "aceblend.com",
  "thestack.club", "decodeage.com", "cosmix.in",
  // Added 2026-09-27. The other big Indian brands (The Whole Truth, Kapiva, Plix,
  // Nutrabay, TrueBasics, Avvatar) run headless storefronts that serve HTML for
  // /products.json, so they stay Amazon-only.
  "purenutrition.in", "traya.health", "nveda.in", "www.gynoveda.com", "melblok.com",
  // Bar-led brands, added once protein bars came into scope (2026-09-27). Their energy
  // and millet bars are still dropped as food; only dosed protein bars survive.
  "www.yogabars.in", "superyou.in", "maxprotein.in",
];
const OUT = path.join(__dirname, "../../e2e/out/products/shopify");
const UA = "Mozilla/5.0 (compatible; VantaOS catalog fetch)";

async function fetchStore(store) {
  const products = [];
  for (let page = 1; page <= 40; page++) {
    const url = `https://${store}/products.json?limit=250&page=${page}`;
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`${store} page ${page}: HTTP ${res.status}`);
    const { products: batch } = await res.json();
    if (!batch?.length) break;
    products.push(...batch);
    if (batch.length < 250) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return products.map((p) => ({
    store,
    id: p.id,
    handle: p.handle,
    url: `https://${store}/products/${p.handle}`,
    title: p.title,
    vendor: p.vendor,
    productType: p.product_type,
    tags: p.tags,
    bodyHtml: p.body_html,
    publishedAt: p.published_at,
    updatedAt: p.updated_at,
    options: p.options?.map((o) => o.name),
    variants: p.variants.map((v) => ({
      id: v.id, title: v.title, sku: v.sku, price: v.price,
      compareAtPrice: v.compare_at_price, available: v.available, grams: v.grams,
      url: `https://${store}/products/${p.handle}?variant=${v.id}`,
    })),
    images: p.images.map((i) => ({ src: i.src, alt: i.alt, w: i.width, h: i.height })),
  }));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const stores = process.argv.slice(2).length ? process.argv.slice(2) : STORES;
  const manifest = {};
  for (const store of stores) {
    try {
      const rows = await fetchStore(store);
      fs.writeFileSync(path.join(OUT, `${store}.json`), JSON.stringify(rows, null, 1));
      manifest[store] = { products: rows.length, fetchedAt: new Date().toISOString() };
      console.log(`${store.padEnd(26)} ${rows.length}`);
    } catch (e) {
      manifest[store] = { error: e.message };
      console.log(`${store.padEnd(26)} ERR ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
})();
