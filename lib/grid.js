// Contact sheet: all of a product's images as numbered tiles in one JPEG, so ONE call can see
// every photo and pick the label tiles. Sending three raw images missed the label panel on
// products with nine photos (issue 8).
import sharp from "sharp";
import { WIDTHS, THRESHOLDS } from "../config/rules.js";

// macOS: sharp's cache and thread pool got the bulk run OOM-killed. Keep it lean (issue 15).
sharp.cache(false);
sharp.concurrency(1);

const COLS = 4;
const PAD = 6;
const UA = "Mozilla/5.0 (compatible; VantaOS catalog fetch)";

async function fetchImg(src) {
  const res = await fetch(src.split("?")[0] + `?width=${WIDTHS.tileFetch}`, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`img ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const badge = (n) =>
  Buffer.from(
    `<svg width="44" height="30"><rect width="44" height="30" rx="4" fill="#111" opacity="0.85"/><text x="22" y="22" font-size="20" font-family="Helvetica,Arial" font-weight="bold" fill="#fff" text-anchor="middle">${n}</text></svg>`,
  );

/** @returns {Promise<{buffer: Buffer, tiles: {index:number, src:string}[]}>} */
export async function contactSheet(images, { fetchImage = fetchImg } = {}) {
  const imgs = (images || []).slice(0, THRESHOLDS.maxTiles);
  const T = WIDTHS.tile;
  const tiles = [];
  for (let i = 0; i < imgs.length; i++) {
    try {
      const raw = await fetchImage(imgs[i].src);
      const buf = await sharp(raw)
        .resize(T, T, { fit: "contain", background: "#fff" })
        .composite([{ input: badge(i), top: 4, left: 4 }])
        .jpeg({ quality: 80 })
        .toBuffer();
      tiles.push({ index: i, src: imgs[i].src, buf });
    } catch {
      // an unreadable image is not a reason to lose the product
    }
  }
  const rows = Math.max(1, Math.ceil(tiles.length / COLS));
  const W = COLS * (T + PAD) + PAD;
  const H = rows * (T + PAD) + PAD;
  const buffer = await sharp({ create: { width: W, height: H, channels: 3, background: "#ddd" } })
    .composite(tiles.map((t, k) => ({ input: t.buf, left: PAD + (k % COLS) * (T + PAD), top: PAD + Math.floor(k / COLS) * (T + PAD) })))
    .jpeg({ quality: 82 })
    .toBuffer();
  return { buffer, tiles: tiles.map(({ index, src }) => ({ index, src })) };
}

export const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString("base64")}`;
