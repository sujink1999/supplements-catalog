// The single copy of every regex, threshold and image width in the pipeline.
// Legacy had NON_SUPP in three drifting copies (bulk_input.js, inspect.js, verify/sample.js)
// and the topical/gear/food classifier in three more (clean.js, amazon_clean.js,
// amazon_prepare.js). Each regex below is the UNION of those copies: a term that appeared in
// any legacy copy appears here, so nothing silently stops applying.

// Union of the three legacy NON_SUPP copies. sample.js's copy was missing the
// `oil\b.*(hair|face|skin|body)` clause that the other two had; it is kept.
export const NON_SUPP =
  /\b(shaker|bottle|t-?shirt|shorts|joggers|leggings|gloves|belt|band|dumbbell|yoga|mat|towel|bag|cap\b|socks|wrist|knee|rope|roller|mug|frother|blender|pad|tampon|razor|wax|cup\b|panty|liner|wipes|cleanser|face wash|shampoo|serum|cream|lotion|oil\b.*(hair|face|skin|body)|sunscreen|lip|perfume|deodorant|soap|scrub|mask|gift card|e-?gift)\b/i;

// amazon_prepare.js GEAR, unchanged (the only copy).
export const GEAR =
  /\b(resistance band|tube band|loop band|skipping rope|jump rope|yoga mat|dumbbell|kettlebell|barbell|weight plate|gym bag|shaker|sipper|bottle|gloves|wrist|knee cap|ankle|support belt|foam roller|massager|gun\b|tape|grip|push[- ]?up|ab roller|hula|treadmill|cycle\b|t-?shirt|shorts|joggers|track ?pant|stringer|vest|socks|cap\b|towel|scale\b|band set)\b/i;

// amazon_prepare.js FOOD, unchanged. Note it deliberately does NOT match "protein bar":
// a dosed protein bar is a supplement (formFactor "bar", isFoodForm true).
export const FOOD =
  /\b(muesli|oats|peanut butter|granola|atta|flour|ghee|honey|spread|chocolate bar|snack bar|cookies|biscuit|namkeen|masala|pickle|rice\b|dal\b|tea bags?)\b/i;

// Union of the three legacy topical regexes: clean.js's (widest), amazon_clean.js's (subset)
// and amazon_prepare.js's (adds beauty/grooming terms).
export const TOPICAL =
  /\b(serum|cream|lotion|shampoo|conditioner|gel\b|balm|face wash|facewash|body wash|scrub|mask\b|hair oil|massage oil|roll-?on|spray|patch|toothpaste|mouthwash|soap|wax|topical|moisturis|sunscreen|beard|deodorant|perfume|wipes|razor|trimmer|lip balm|kajal|foundation|nail|for (hair|skin|face|scalp) (oil|application))\b/i;

// Union of clean.js TOPICAL_FORM and amazon_clean.js TOPICAL_FORM (formFactor values).
export const TOPICAL_FORM = /^(cream|serum|gel|lotion|oil_topical|topical|spray)$/i;

// amazon_prepare.js NON_FORM: Amazon's own "item form" attribute saying it is not ingestible.
export const NON_FORM = /^(?:band|mat|bottle|apparel|cream|serum|lotion|gel|spray|shampoo|soap|oil)$/i;

// clean.js: a dose instruction that gives the game away even when the title looks ingestible.
export const TOPICAL_DIRECTIONS = /apply (to|on) (the )?(skin|scalp|hair|face)/i;

// clean.js: a title that names a pack/bundle is not rescued as "title only" when it has no actives.
export const MULTI_WORD = /\b(pack|bundle|combo|kit|stack)\b/i;

// extract.js: signals that make an image-led "bundle" call believable (issue 13).
export const COMBO_SIGNAL = /combo|bundle|kit|stack|duo|trio|\+/;

// clean.js: servingSize strings that let servingsPerContainer be turned into a unit count.
export const UNIT_SERVING = /^\s*(\d+)\s*(capsule|tablet|softgel|gummy|gummies|sachet|stick|strip)/i;

// clean.js splitNetQty: the unit vocabulary real Indian labels use.
export const NET_QTY_UNITS =
  "kg|g|gm|gms|grams?|mg|mcg|ml|l|litres?|liters?|sachets?|sticks?|strips?|capsules?|caps?|tablets?|tabs?|softgels?|gummies|gummy|servings?|scoops?|shots?|vials?|pcs?|pieces?|N";

// certs.js CLAIMS: candidate-detection only. Regex is not trusted to adjudicate claim
// semantics (issue 38) — the LLM does that — but the keyword hits are kept as a fallback
// signal on rows that never got a judged read.
export const CLAIMS = [
  ["fssai_licence", /\bfssai\s*(?:lic(?:ence|ense)?\s*(?:no\.?|number)?\s*[:#]?\s*)?(\d{11,14})\b/i],
  ["fssai", /\bfssai\b/i],
  ["informed_sport", /\binformed[- ]sport\b/i],
  ["informed_choice", /\binformed[- ]choice\b/i],
  ["nsf_certified", /\bnsf\b(?!\s*=)/i],
  ["labdoor", /\blabdoor\b/i],
  ["banned_substance_tested", /\b(?:banned[- ]substance|dope|doping)[- ]?(?:free|tested|safe)\b|\bwada\b|\bnada\b/i],
  ["third_party_tested", /\b(?:third|3rd)[- ]party\s*(?:lab\s*)?(?:tested|testing|verified|certified)\b/i],
  ["lab_tested", /\b(?:lab|laboratory|clinically)\s*(?:tested|verified)\b/i],
  ["heavy_metal_tested", /\bheavy[- ]metals?\b[^.]{0,40}\b(?:tested|free|screened|safe)\b|\btested\b[^.]{0,30}\bheavy[- ]metals?\b/i],
  ["certificate_of_analysis", /\b(?:certificate of analysis|coa)\b/i],
  ["gmp", /\bgmp\b|\bgood manufacturing practice/i],
  ["haccp", /\bhaccp\b/i],
  ["iso_certified", /\biso[\s-]?(?:9001|22000|\d{4,5})\b/i],
  ["us_fda_registered", /\b(?:us\s*)?fda[- ](?:registered|approved|compliant)\b/i],
  ["ayush", /\bayush\b/i],
  ["usda_organic", /\busda\s*organic\b/i],
  ["india_organic", /\bindia\s*organic\b|\bjaivik bharat\b/i],
  ["non_gmo", /\bnon[- ]?gmo\b/i],
  ["gluten_free", /\bgluten[- ]free\b/i],
  ["vegan", /\bvegan\b/i],
  ["vegetarian", /\b(?:100%\s*)?veg(?:etarian)?\b(?!\s*capsule)/i],
  ["sugar_free", /\b(?:sugar[- ]free|no added sugar|zero sugar)\b/i],
  ["no_artificial", /\bno artificial (?:colou?rs?|flavou?rs?|sweeteners?|preservatives?)\b/i],
  ["made_in_india", /\bmade in india\b/i],
];

// Image widths. Legacy had three unnamed magic numbers.
export const WIDTHS = {
  // grid.js fetched each tile at 640 before downscaling to a 320px tile.
  tileFetch: 640,
  // The contact-sheet tile edge, 4 per row, number burned in.
  tile: 320,
  // Label reads. 1600x1600 is exactly the model's 2,500-patch budget: verified against the
  // vendor's docs (issue 48), so there is nothing to gain from going higher.
  label: 1600,
};

export const THRESHOLDS = {
  // grid.js MAX_TILES.
  maxTiles: 16,
  // extract2.js labelTiles.slice(0, 4) — four is the most real panels seen in the field.
  maxLabelTiles: 4,
  // extract2.js: a panel narrower than this is rarely legible, so confidence is capped.
  lowResLabelWidth: 800,
  lowResConfidenceCap: 0.6,
  // clean.js / amazon_clean.js / fill_apply.js all repeated this cutoff.
  lowConfidence: 0.7,
  // amazon_brand.js STOP_OOS: a page this sold out is discontinued stock, stop paging.
  stopOutOfStockRatio: 0.34,
  // amazon_brand.js: items requested per Apify run, and the default depth cap.
  amazonPageSize: 30,
  amazonMaxItems: 40,
  // adjudicate.js same(): amounts within this relative distance are the same reading.
  amountTolerance: 0.02,
  // check.js code rules.
  absurdAmount: 100000,
  kcalMacroTolerance: 0.25,
  // max_completion_tokens per call. 8000 because dense whey panels truncated at 3000 (issue 14).
  classifyMaxTokens: 600,
  factsMaxTokens: 8000,
  checkMaxTokens: 900,
  // Units whose amounts are legitimately huge (enzyme activity, colony counts).
  bigUnits: ["cfu", "billion cfu", "million cfu", "billion cfu/g", "fccpu", "hut", "iu", "i.u."],
};

export const MODELS = {
  // $0.10/$0.50 per Mtok, and it matched gpt-6-sol on every active in a 20-product A/B.
  default: process.env.CATALOG_MODEL || "gpt-6-luna",
  // chat.completions rejects reasoning_effort alongside tools, so high effort goes through
  // /v1/responses with text.format.json_schema instead.
  rereadEffort: "high",
  prices: {
    "gpt-6-luna": [0.1, 0.5],
    "gpt-6-sol": [2, 10],
    "gpt-6-astra": [10, 50],
    "gpt-5.6-luna": [0.2, 1.2],
    "gpt-5.6-sol": [4, 20],
    "gpt-5.4-mini": [0.75, 4.5],
  },
};

// Per-product averages measured from the legacy runs; see README "cost model".
export const COSTS = {
  // First bulk run: 3,252 Shopify rows, $7.62. The 45-item verify pass agreed ($0.10 → $0.0022).
  extractPerProduct: 0.0023,
  // High-effort tiebreak: $1.354 over 390 products.
  rereadPerProduct: 0.00347,
  // Text-only check: no legacy figure exists for exactly this call, so it is derived from
  // ~1.5k input + ~200 output tokens at gpt-6-luna pricing.
  checkPerProduct: 0.00025,
  // Share of products the code rules plus the text check are expected to flag for re-read
  // (legacy: 390 disputed of 2,771).
  flagRate: 0.15,
  // Apify junglee/amazon-crawler, PAY_PER_EVENT, with product details.
  apifyPerProduct: 0.004,
};

export const APIFY = {
  actor: "junglee~amazon-crawler",
  proxyCountry: "IN",
  memoryMbytes: 1024,
  pollMs: 15000,
  itemLimit: 1000,
};

export const SCHEMA_VERSION = 1;
