// One Apify client. Legacy had four near-identical copies of start/poll/items with different
// timeouts (amazon_brand, amazon_fill, amazon_price, apify_probe).
// Runs routinely exceed the 300s synchronous limit, so every run starts detached and is polled.
import { requireEnv } from "./env.js";
import { APIFY } from "../config/rules.js";
import * as ledger from "./ledger.js";

const token = () => requireEnv("APIFY_TOKEN");

export async function startRun(url, maxItems) {
  const body = {
    categoryOrProductUrls: [{ url }],
    maxItemsPerStartUrl: maxItems,
    scrapeProductDetails: true,
    scrapeProductVariantPrices: false,
    proxyCountry: APIFY.proxyCountry,
    useCaptchaSolver: false,
  };
  const r = await fetch(`https://api.apify.com/v2/acts/${APIFY.actor}/runs?token=${token()}&memory=${APIFY.memoryMbytes}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`apify start HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data;
}

export async function waitRun(id, { pollMs = APIFY.pollMs } = {}) {
  for (;;) {
    await new Promise((s) => setTimeout(s, pollMs));
    const r = await fetch(`https://api.apify.com/v2/actor-runs/${id}?token=${token()}`);
    const d = (await r.json()).data;
    if (d.status !== "RUNNING" && d.status !== "READY") return d;
  }
}

export async function items(datasetId) {
  const r = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token()}&limit=${APIFY.itemLimit}`);
  return r.ok ? r.json() : [];
}

// The crawler only accepts /s?k= search and /dp/ product URLs; a /stores/ brand page is
// rejected (issue 33). A brand facet is &rh=p_89%3A<brand>.
export function searchUrl(query, { brandFacet = null, page = 1 } = {}) {
  let u = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
  if (brandFacet) u += `&rh=p_89%3A${encodeURIComponent(brandFacet)}`;
  if (page > 1) u += `&page=${page}`;
  return u;
}

// One paged run, logged with the provider's own usage figure rather than a guess.
export async function runPage({ url, maxItems, runId, stage, budget, pollMs }) {
  const run = await startRun(url, maxItems);
  const done = await waitRun(run.id, { pollMs });
  const usd = done.usageTotalUsd || 0;
  ledger.record({ runId, stage, call: "apify_run", key: url, provider: "apify", apifyRunId: run.id, status: done.status, usd });
  if (budget) budget.add(usd);
  if (done.status !== "SUCCEEDED") return { status: done.status, rows: [], usd };
  return { status: done.status, rows: await items(done.defaultDatasetId), usd };
}
