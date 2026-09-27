// One env loader for the whole repo. Legacy pasted a root-walking dotenv block into 7+ files
// with two different guesses at the repo depth (issue 1); this repo owns its own .env.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  for (const f of [".env", ".env.local"]) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) dotenv.config({ path: p, override: f === ".env.local", quiet: true });
  }
}

export function requireEnv(name) {
  loadEnv();
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return v;
}

// data/ is gitignored and holds paid LLM output. Never delete anything under it.
export const dataDir = () => {
  loadEnv();
  return path.resolve(ROOT, process.env.CATALOG_DATA_DIR || "data");
};
