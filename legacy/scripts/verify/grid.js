// Contact sheet: all of a product's images as numbered tiles in one JPEG.
// Returns { buffer, tiles: [{index, src}] }. Tiles are 320px wide, 4 per row, number burned in top-left.
const sharp = require("sharp");
// macOS: sharp's cache + threads made the bulk run get OOM-killed. Keep it lean.
sharp.cache(false); sharp.concurrency(1);

const TILE = 320, COLS = 4, PAD = 6, MAX_TILES = 16;
const UA = "Mozilla/5.0 (compatible; VantaOS catalog fetch)";

async function fetchImg(src) {
  const url = src.split("?")[0] + "?width=640";
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`img ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function badge(n) {
  return Buffer.from(`<svg width="44" height="30"><rect width="44" height="30" rx="4" fill="#111" opacity="0.85"/><text x="22" y="22" font-size="20" font-family="Helvetica,Arial" font-weight="bold" fill="#fff" text-anchor="middle">${n}</text></svg>`);
}

async function contactSheet(images) {
  const imgs = images.slice(0, MAX_TILES);
  const tiles = [];
  for (let i = 0; i < imgs.length; i++) {
    try {
      const raw = await fetchImg(imgs[i].src);
      const t = await sharp(raw).resize(TILE, TILE, { fit: "contain", background: "#fff" }).composite([{ input: badge(i), top: 4, left: 4 }]).jpeg({ quality: 80 }).toBuffer();
      tiles.push({ index: i, src: imgs[i].src, buf: t });
    } catch (e) { /* skip unreadable image */ }
  }
  const rows = Math.ceil(tiles.length / COLS);
  const W = COLS * (TILE + PAD) + PAD, H = rows * (TILE + PAD) + PAD;
  const buffer = await sharp({ create: { width: W, height: H, channels: 3, background: "#ddd" } })
    .composite(tiles.map((t, k) => ({ input: t.buf, left: PAD + (k % COLS) * (TILE + PAD), top: PAD + Math.floor(k / COLS) * (TILE + PAD) })))
    .jpeg({ quality: 82 }).toBuffer();
  return { buffer, tiles: tiles.map(({ index, src }) => ({ index, src })) };
}

module.exports = { contactSheet };
