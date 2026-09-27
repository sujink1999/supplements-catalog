// One key builder. Legacy wrote Amazon keys three ways (`amazon__<asin>`,
// `amazon.in__<asin>`, `<shopifyKey>__<asin>`) and a lookup that assumed the wrong one
// silently under-matched 385 products (issue 44).
export const AMAZON_STORE = "amazon.in";

export const shopifyKey = (store, id) => `${store}__${id}`;
export const amazonKey = (asin) => `${AMAZON_STORE}__${asin}`;

export const keyOf = (row) =>
  row.source === "amazon" || row.store === AMAZON_STORE
    ? amazonKey(row.asin ?? row.id)
    : shopifyKey(row.store, row.id);

// A key is `<store>__<id>`; the store may itself contain dots but never a double underscore.
export function parseKey(key) {
  const i = String(key).indexOf("__");
  if (i < 0) return { store: null, id: String(key), source: null };
  const store = key.slice(0, i);
  const id = key.slice(i + 2);
  return { store, id, source: store === AMAZON_STORE ? "amazon" : "shopify" };
}

// Filenames: keys are already filesystem-safe (store domains and numeric ids/ASINs), but
// guard anyway so a surprising id cannot escape the directory.
export const keyToFile = (key) => String(key).replace(/[^A-Za-z0-9._-]/g, "_");
