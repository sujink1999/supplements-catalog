// Listing text: stripping, the claim-trigger excerpt, and the regex candidate scan.
import { CLAIMS } from "../config/rules.js";

export const stripHtml = (h) =>
  String(h || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

// Sentences that mention something worth judging. A fixed 320-char sentence rule lost 115
// listings whose whole description is one unpunctuated bullet block (issue 39), so long blocks
// get a window around each match instead of being dropped.
const TRIGGER =
  /\b(spik|aflatoxin|radiat|solvent|adulterat|halal|kosher|stability|shelf.life|test|tested|testing|verified|certif|lab\b|nabl|labdoor|nsf|informed|wada|nada|dope|doping|banned|heavy metal|coa|certificate of analysis|fssai|ayush|gmp|haccp|iso\s?\d|fda|organic|vegan|vegetarian|gluten|sugar[- ]free|gmo|purity|potency|assay|contaminant|pesticide|allergen)\b/i;

export function claimExcerpt(text, { maxParts = 18, window = 130, maxChars = 2000 } = {}) {
  const parts = String(text || "").split(/(?<=[.!?•])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (!TRIGGER.test(p)) continue;
    if (p.length <= 320) {
      out.push(p);
      continue;
    }
    const re = new RegExp(TRIGGER.source, "gi");
    let m;
    while ((m = re.exec(p)) && out.length < maxParts) {
      out.push(p.slice(Math.max(0, m.index - window), m.index + m[0].length + window).trim());
      re.lastIndex = m.index + m[0].length + window;
    }
  }
  return [...new Set(out)].slice(0, maxParts).join(" … ").slice(0, maxChars);
}

// Candidate detection only. Regex was ~75% precise at judging claim semantics (issue 38), so
// these hits are kept as keywordClaims, never as a verified certification.
export function scanClaims(text) {
  const t = String(text || "");
  const found = [];
  let licence = null;
  for (const [name, re] of CLAIMS) {
    const m = t.match(re);
    if (!m) continue;
    if (name === "fssai_licence") {
      licence = m[1];
      found.push("fssai");
      continue;
    }
    if (name === "fssai" && licence) continue;
    found.push(name);
  }
  return { claims: [...new Set(found)], fssaiLicence: licence };
}
