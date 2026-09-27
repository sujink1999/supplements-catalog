// The verification ladder, computed once. Legacy recomputed it in clean.js, amazon_clean.js
// and fill_apply.js with the same five tiers and the same <0.7 cutoff in three places.
import { THRESHOLDS } from "../config/rules.js";

export const TIERS = {
  label_read: 3,
  unverified_low_res: 2,
  unverified_low_confidence: 2,
  unverified_no_label: 1,
  unverified_title_only: 0,
};

export const rank = (tier) => TIERS[tier] ?? -1;

/**
 * @param {object} a
 * @param {boolean} a.titleOnly   kept on the title alone: no actives and no label image
 * @param {boolean} a.hasLabel    at least one label tile was read
 * @param {boolean} a.lowResLabel every label image was under the legibility width
 * @param {number}  a.confidence  the model's own confidence for the whole extraction
 */
export function verificationTier({ titleOnly, hasLabel, lowResLabel, confidence }) {
  if (titleOnly) return "unverified_title_only";
  if (!hasLabel) return "unverified_no_label";
  if (lowResLabel) return "unverified_low_res";
  if (Number(confidence) < THRESHOLDS.lowConfidence) return "unverified_low_confidence";
  return "label_read";
}

// A bar is dosed like a supplement but eaten like food, so a recommender can keep it out of an
// answer about capsules without parsing the form string.
export const isFoodForm = (formFactor) => String(formFactor || "").toLowerCase() === "bar";
