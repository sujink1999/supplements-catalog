// Per-key JSON directory helpers. Legacy copy-pasted readDir() into clean.js and
// amazon_clean.js and hand-rolled "skip if the file exists" in every stage.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./env.js";
import { keyToFile } from "./keys.js";

export const dir = (...parts) => {
  const p = path.join(dataDir(), ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

export const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

export function writeJson(file, value, { pretty = 1 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, pretty));
  return file;
}

export const keyPath = (d, key, ext = ".json") => path.join(d, keyToFile(key) + ext);
export const hasKey = (d, key, ext = ".json") => fs.existsSync(keyPath(d, key, ext));
export const readKey = (d, key) => readJson(keyPath(d, key));
export const writeKey = (d, key, value) => writeJson(keyPath(d, key), value);

// Every <key>.json in a directory, as { key: value }. Missing directory is not an error:
// a stage that has never run yet is a normal state, not a crash.
export function readKeyDir(d) {
  const out = {};
  if (!fs.existsSync(d)) return out;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    const v = readJson(path.join(d, f));
    if (v != null) out[f.slice(0, -5)] = v;
  }
  return out;
}

// Keep the previous version of a record next to it rather than overwriting paid output.
export function keepPrevious(file) {
  if (!fs.existsSync(file)) return null;
  const prev = file.replace(/\.json$/, ".prev.json");
  fs.copyFileSync(file, prev);
  return prev;
}

// Snapshots are versioned; N is "one past the highest that exists".
export function nextSnapshotVersion(snapDir) {
  if (!fs.existsSync(snapDir)) return 1;
  const ns = fs
    .readdirSync(snapDir)
    .map((f) => /^catalog-v(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return ns.length ? Math.max(...ns) + 1 : 1;
}
