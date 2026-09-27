// Stage 3: one extraction read per product, two calls.
//   Call 1  contact sheet of every photo + title/variants + a claim-trigger excerpt of the
//           description: classify the listing, pick the label tiles, judge the text claims.
//   Call 2  up to 4 chosen label tiles at width 1600, pack photos FIRST: the facts panel and
//           the marks printed on the same pack.
// Out: data/extract/<key>.json + <key>.grid.jpg. Skips an existing record unless --force.
import fs from "node:fs";
import path from "node:path";
import { THRESHOLDS, WIDTHS, MODELS, COMBO_SIGNAL, SCHEMA_VERSION } from "../config/rules.js";
import { call1, call2, pick, CLASSIFY_KEYS, CLAIMS_KEYS, FACTS_KEYS, MARKS_KEYS } from "../lib/prompts.js";
import { contactSheet, dataUrl } from "../lib/grid.js";
import { callJson, atWidth } from "../lib/openai.js";
import { dir, readJson, writeJson, keyPath, keepPrevious } from "../lib/store.js";
import { slugify } from "../lib/brands.js";
import { stripHtml, claimExcerpt, scanClaims } from "../lib/text.js";
import { pool } from "../lib/pool.js";

const metaBlock = (p, tiles) =>
  `Store: ${p.store}\nTitle: ${p.title}\nVendor: ${p.vendor}\nType: ${p.productType || "-"}\n` +
  `Variants: ${(p.variants || []).map((v) => v.title + " ₹" + v.price).join(" | ")}\n` +
  `Tiles: ${tiles.length} (numbered 0..${tiles.length - 1})`;

/**
 * Image-led bundle false positives: the model sees several boxes in one photo and calls a
 * single product a combo (OZiva, issue 13). The prompt rule alone was systematically ignored,
 * so demote unless the title/variants actually name the components.
 */
export function demoteBundle(cls, p) {
  if (cls.listing !== "supplement" || cls.pack !== "bundle") return cls;
  const hay = (p.title + " " + (p.variants || []).map((v) => v.title).join(" ")).toLowerCase();
  const comboSignal = COMBO_SIGNAL.test((p.title + " " + (p.productType || "") + " " + (p.tags || []).join(" ")).toLowerCase());
  const stop = new Set(["the", "and", "for", "with", "of", "a", "pack", "capsules", "tablets", "powder", "plus", (p.vendor || "").toLowerCase()]);
  const unnamed = (cls.bundleComponents || []).filter((c) =>
    c.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 2 && !stop.has(w) && !hay.includes(w)),
  );
  if (!comboSignal && ((cls.bundleComponents || []).length < 2 || unnamed.length)) {
    cls.pack = "single";
    cls.reason += ` [code: bundle demoted to single; unnamed components ${JSON.stringify(unnamed)}]`;
  }
  return cls;
}

/**
 * The physical pack is the legal label; a spec graphic is marketing the brand may never have
 * reprinted (issue 59). Pack photos first so the model reads them first, capped at 4 tiles.
 */
export function orderLabelTiles(cls, tiles) {
  const picked = (cls.labelTiles || [])
    .map((i, n) => ({ src: tiles[i]?.src, kind: cls.labelTileKinds?.[n] || "pack_photo" }))
    .filter((x) => x.src);
  const ordered = [...picked.filter((x) => x.kind === "pack_photo"), ...picked.filter((x) => x.kind !== "pack_photo")].slice(
    0,
    THRESHOLDS.maxLabelTiles,
  );
  return { labelImages: ordered.map((x) => x.src), labelKinds: ordered.map((x) => x.kind) };
}

/** A panel narrower than 800px is rarely legible, so cap confidence and say so. */
export function applyLowRes(facts, labelImages, images) {
  const wOf = (src) => (images.find((im) => im.src === src) || {}).w || 0;
  const lowRes = labelImages.length > 0 && labelImages.every((src) => wOf(src) > 0 && wOf(src) < THRESHOLDS.lowResLabelWidth);
  if (!lowRes) return facts;
  facts.lowResLabel = true;
  facts.confidence = Math.min(facts.confidence, THRESHOLDS.lowResConfidenceCap);
  facts.notes = `LOW-RES LABEL (<${THRESHOLDS.lowResLabelWidth}px): amounts may be misread. ` + (facts.notes || "");
  return facts;
}

export async function extractOne(p, { model = MODELS.default, effort = "none", runId, budget, gridFile }) {
  const t0 = Date.now();
  const { buffer, tiles } = await contactSheet(p.images);
  if (gridFile) fs.writeFileSync(gridFile, buffer);
  const meta = metaBlock(p, tiles);
  const description = stripHtml(p.bodyHtml);

  const c1 = await callJson({
    ...call1,
    content: [
      { type: "image_url", url: dataUrl(buffer) },
      { type: "text", text: `${meta}\n\nListing text (claim-bearing excerpt):\n${claimExcerpt(`${p.title}. ${description}`)}` },
    ],
    maxTokens: THRESHOLDS.classifyMaxTokens,
    effort,
    model,
    stage: "extract",
    key: p.key,
    runId,
    budget,
  });
  const cls = demoteBundle(pick(c1.out, CLASSIFY_KEYS), p);
  const claims = pick(c1.out, CLAIMS_KEYS);
  const usage = { in: c1.usage.in, out: c1.usage.out };
  let usd = c1.usd || 0;

  let facts = null;
  let packMarks = null;
  let labelImages = [];
  let labelKinds = [];
  if (cls.listing === "supplement" && cls.pack !== "bundle") {
    ({ labelImages, labelKinds } = orderLabelTiles(cls, tiles));
    const content = labelImages.map((src) => ({ type: "image_url", url: atWidth(src, WIDTHS.label) }));
    content.push({ type: "text", text: `${meta}\n\nDescription:\n${description.slice(0, 6000)}` });
    const c2 = await callJson({
      ...call2,
      content,
      maxTokens: THRESHOLDS.factsMaxTokens,
      effort,
      model,
      stage: "extract",
      key: p.key,
      runId,
      budget,
    });
    facts = applyLowRes(pick(c2.out, FACTS_KEYS), labelImages, p.images || []);
    packMarks = pick(c2.out, MARKS_KEYS);
    usage.in += c2.usage.in;
    usage.out += c2.usage.out;
    usd += c2.usd || 0;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    key: p.key,
    source: p.source,
    store: p.store,
    id: p.id,
    asin: p.asin ?? null,
    url: p.url,
    title: p.title,
    brand: p.brand,
    model,
    effort,
    runId,
    extractedAt: new Date().toISOString(),
    imageCount: (p.images || []).length,
    tiles,
    classify: cls,
    labelImages,
    labelKinds,
    facts,
    packMarks,
    claims,
    // certs.js's keyword pass, kept only as a fallback signal where judging found nothing.
    keywordClaims: scanClaims(`${p.title} ${description} ${(p.tags || []).join(" ")}`).claims,
    usage,
    usd,
    ms: Date.now() - t0,
    // The raw call outputs, so a schema change never means re-paying for the read.
    raw: { call1: c1.out, call2: facts ? { ...facts, ...packMarks } : null },
  };
}

export async function run({ brand, force = false, conc = 4, limit = 0, only = [], effort = "none", model = MODELS.default, runId, budget, log = console.log }) {
  const slug = slugify(brand);
  const input = readJson(path.join(dir("filtered"), `${slug}.json`), null);
  if (!input) throw new Error(`no filtered input at data/filtered/${slug}.json — run filter first`);
  const outDir = dir("extract");

  let todo = input;
  if (only.length) todo = todo.filter((p) => only.includes(p.key) || only.includes(String(p.id)));
  if (!force) todo = todo.filter((p) => !fs.existsSync(keyPath(outDir, p.key)));
  if (limit) todo = todo.slice(0, limit);
  log(`${todo.length} to extract (of ${input.length}) model=${model} effort=${effort} conc=${conc}`);

  let n = 0;
  const { errors } = await pool(todo, conc, async (p) => {
    const file = keyPath(outDir, p.key);
    if (force) keepPrevious(file);
    const r = await extractOne(p, { model, effort, runId, budget, gridFile: keyPath(outDir, p.key, ".grid.jpg") });
    writeJson(file, r);
    n++;
    const f = r.facts;
    log(
      `[${n}/${todo.length}] ${r.classify.listing === "supplement" ? r.classify.pack.padEnd(10) : "NOT_SUPP  "}` +
        ` tiles=${String(r.tiles.length).padStart(2)} label=[${r.classify.labelTiles}]` +
        ` ${f ? `c=${f.confidence} rows=${f.rows.length} act=${f.rows.filter((x) => x.role === "active").length}` : "-"}` +
        ` ${r.ms}ms ${p.title.slice(0, 55)}`,
    );
  });
  return { extracted: n, errors };
}
