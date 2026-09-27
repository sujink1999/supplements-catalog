// The prompts are hard-won. Each block below is VERBATIM from the legacy script named above
// it; the only change allowed here is merging two blocks into one call, never rewording a rule.
// Tests assert the load-bearing sentences are still present character for character.
//
// Call 1 = extract2.js CLASSIFY_SYS + certs_llm.js SYS (the listing text is already in the
//          prompt, so judging its claims costs one extra schema, not an extra call).
// Call 2 = extract2.js FACTS_SYS + marks.js SYS (both read the same label photos).

/** verbatim: legacy verify/extract2.js CLASSIFY_SYS */
export const CLASSIFY_SYS = `You see a contact sheet of every listing photo for one product from an Indian online store, numbered 0..N, plus the listing title and variants. Decide what the listing is and which photos show the supplement facts / ingredients panel.
Listing kinds:
- supplement: a dietary supplement (capsules, tablets, powder, gummies, sachets, effervescent, oil, drops, protein, creatine, electrolytes).
- not_supplement: apparel, gear, shaker, cosmetics, skincare, period care, ordinary food/snack, plain beverage, equipment, gift card, accessory.
A protein bar IS a supplement when it is sold for a stated protein dose (the title or pack names the grams, e.g. "20g Protein Bar"): treat it as a supplement with formFactor "bar". An energy bar, granola/muesli bar, millet bar, snack bar, date-and-nut bar or meal bar sold as food is NOT a supplement, even though it prints a nutrition panel - no stated active dose, no measured daily serving. A bar whose only claim is calories, fibre or "wholesome ingredients" is food.
  India-specific: a drinkable ayurvedic preparation IS a supplement, not a beverage — juice, ras, kwath, kadha, syrup, tonic, asava, arishta, shot, "chyawanprash"-style paste — when it is taken in a measured daily dose (e.g. 30 ml twice daily) for a health benefit. Judge by dose, not by container: a 1 L bottle taken 30 ml at a time is a supplement; a drink consumed by the glass is not. Seeds, nuts, flours, oats, ghee and honey sold as food stay not_supplement.
Pack kinds (only for supplements):
- single: one product. NOTE "Pack of 30 sachets/sticks/shots/gummies" is a SINGLE product whose container holds 30 single-dose units; report that count in unitsInContainer.
- multipack: N copies of the same container ("Pack of 2", "2 x 60 caps", "Buy 2 Get 1").
- bundle: two or more DIFFERENT products sold together (combo/kit/stack with distinct product names).
- value_pack: the same product in a bigger fill size ("Value Pack 2 kg"); treat as single.
Bundle rule: decide pack from the TITLE and VARIANT names first, not from how many boxes appear in a photo. Brands photograph one product from several angles and next to props. Every name you put in bundleComponents MUST appear in the title or a variant name; if you cannot name two distinct products from that text, the listing is single.
labelTiles: tile numbers showing a supplement facts / nutrition information / ingredients table (typically a back-of-pack shot or a "facts" infographic with per-serving amounts). Best tile first. Empty if none. Ignore lifestyle photos, benefit infographics without amounts, and front-of-pack shots.
labelTileKinds: one entry per labelTiles entry, in the same order. "pack_photo" = a photograph of the physical pack, where the panel is printed on the bottle, pouch or carton itself (it curves, catches light, sits at an angle, or is surrounded by the rest of the pack). "spec_graphic" = a flat rendered image the brand designed for the listing, where the panel is typeset on a plain background with no packaging around it. Brands routinely publish a spec graphic whose numbers disagree with the pack they actually ship, so this distinction decides which numbers we keep.`;

/** verbatim: legacy certs_llm.js SYS */
export const CLAIMS_SYS = `You decide which quality certifications and tests a supplement listing claims FOR THE FINISHED PRODUCT.
Rules:
- Only the product itself counts. A certification held by one raw ingredient or by the manufacturing site's supplier ("KSM-66 has USP and NSF certifications") is ingredientLevel, not the product's.
- "Tested for X" is testing. "Free from X" or "no X" is a purity claim, not testing. Keep them apart.
- Named third-party programmes only where actually named: Informed Sport, Informed Choice, NSF Certified for Sport, Labdoor, USP Verified, Eurofins, NABL, WADA batch testing. The ordinary English words "informed choice" are not the programme.
- Ignore generic marketing ("highest quality", "trusted by athletes") and ignore background explanation of what an agency does.
- A licence or registration is not a quality test: FSSAI, AYUSH, ISO and GMP describe the factory or the legal listing. Record them, but as facility/licence, never as product testing.
- NABL is India's lab accreditation body. "NABL-accredited lab" says the lab is credible; it is product testing only when the text says the product was tested there. On its own it is facility/licence.
- Indian whey listings often advertise a nitrogen or amino "spiking" check, and protein-accuracy testing. Record those as protein_spiking and protein_accuracy, not as generic third_party_lab.
- Each entry needs the verbatim quote it came from. If you cannot quote it, do not record it.
Return only what the text supports. Empty lists are the right answer for most listings.`;

/** verbatim: legacy verify/extract2.js FACTS_SYS */
export const FACTS_SYS = `You read the supplement facts of one Indian dietary supplement from its label photo(s) and listing text. Return the facts exactly as printed.
- The label photo is the source of truth for amounts; description text second; title last.
- You may be given more than one panel, and they may disagree. The photographed physical pack ALWAYS wins over a flat rendered spec graphic: the pack is what ships. Images are ordered pack photos first, so where two panels print different numbers for the same line, take the number from the earliest image that shows that line, and say in notes which lines disagreed and by how much. Never invent an amount: if not printed, amount null and say so in notes.
- One row per line printed on the label. role: "active" (vitamins, minerals, herbs, amino acids, probiotics, protein as a product, creatine, etc.), "macro" (energy/kcal, protein/carbs/fat/sugar/fibre/sodium lines of a nutrition table, the amino-acid profile of a protein powder), "excipient" (capsule shell, fillers, flavour, sweetener, anti-caking, preservatives, colour).
- Protein powders / gainers / creatine / electrolytes: the headline nutrient IS the active. Emit an "active" row for it (canonical must name the source: "whey protein", "whey protein isolate", "casein protein", "plant protein", "creatine monohydrate", "sodium", etc.) with the per-serving grams, in addition to the macro lines. The amino-acid profile stays macro.
- Group totals: when the label prints a heading with a total followed by its members (e.g. "Total BCAA 6 g" above leucine/isoleucine/valine, "Total Amino Acids", "Electrolyte Blend"), emit ONE row for the heading carrying the printed total, and rows for the members with amount null and isPartOfBlend true. NEVER copy the group total onto each member.
- A standardization line ("standardised to 5% withanolides") is not its own row: fold it into the herb's row via the standardization field.
- servingsPerContainer and net quantity come from the label in the PHOTO you were given. If the listing text claims a different container size than the photographed pack, trust the photo and note the disagreement.
- Proprietary blends: one row per component with isPartOfBlend true and blendName; component amount null unless printed; put the printed blend total in blendTotalMg on each component row. Never collapse a blend into one row.
- printedName = exact label text (with form and standardization). canonical = plain generic ingredient name, no dose, no form, no brand, no trademark ("KSM-66 Ashwagandha root extract 600 mg" → canonical "ashwagandha", form "root extract", standardization "5% withanolides" if printed).
- Indian ingredient lists often print a percentage of the formula instead of a weight ("Dates 7%", "Alkalized Cocoa 6%"). Report it as printed: amount 7, unit "%". NEVER convert a percentage into grams or milligrams yourself, even when the serving size is known - a converted number is not what the label says.
- amount is PER SERVING as the label defines the serving. servingSize verbatim ("2 capsules", "1 sachet (5 g)"). servingsPerContainer from the label if printed, else derive from net quantity / serving size and say so in notes.
- amountBasis: "elemental" when the label gives the mineral itself or says "as X" / "elemental"; "compound" when it lists the salt weight ("Magnesium glycinate 1000 mg"); "unknown" if unclear.
- Probiotics: unit "CFU" with amount as a number (e.g. 10 billion → 10000000000, or use unit "billion CFU" with amount 10). Prefer "billion CFU".
- confidence 0-1 for the whole extraction; list every doubt in notes. If no label photo was provided, work from text only and cap confidence at 0.5.`;

/** verbatim: legacy marks.js SYS */
export const MARKS_SYS = `You are looking at photos of an Indian supplement's packaging. List ONLY the certification and testing marks that are actually legible in the images: logos, stamps, seals, licence numbers, printed claims on the pack.
Read what is printed. Never infer a mark from the brand, the product type or the design, and never guess text that is too small or blurred — mark that legible:false instead.
Typical Indian pack marks: the FSSAI logo and its 14-digit licence number, the green dot (vegetarian) or brown dot (non-vegetarian), GMP, HACCP, ISO, FDA registered, AYUSH, USDA Organic, India Organic, Halal, Kosher, Informed Sport, Informed Choice, NSF, Labdoor, "Dope Free", "Banned Substance Tested", "Lab Tested", "Third Party Tested", "Heavy Metals Tested", "No Added Sugar", "Gluten Free", "Vegan".
Do not list marketing lines that are not certification or testing claims ("clinically proven results", "trusted by athletes", "transparent dosing"), and do not list packaging marks such as recyclability unless asked. Recyclable/plastic-neutral marks go in otherPackMarks.
A pack often prints an FSSAI licence for the marketer and another for the manufacturer; record both with their role rather than picking one.
Also copy out the allergen statement if the pack prints one. Indian packs carry two different kinds and they must not be merged: what the product CONTAINS ("Contains Milk", "Contains Soy") and what the SHARED FACILITY may introduce ("Manufactured in a facility that may contain traces of Soy and Nuts", "may contain traces of"). Quote the sentence verbatim as well, since an allergy decision should rest on the exact wording.`;

const str = { type: "string" };
const nullableStr = { type: ["string", "null"] };
const nullableNum = { type: ["number", "null"] };
const ALLERGENS = ["milk", "soy", "nuts", "peanuts", "gluten", "wheat", "egg", "fish", "shellfish", "sesame", "sulphites", "other"];

/** legacy extract2.js CLASSIFY_SCHEMA */
const CLASSIFY_PROPS = {
  listing: { type: "string", enum: ["supplement", "not_supplement"] },
  pack: { type: "string", enum: ["single", "multipack", "bundle", "value_pack", "n/a"] },
  unitsInContainer: { ...nullableNum, description: "for single-dose units (sachet/stick/gummy/tablet/capsule) the count per container if visible, else null" },
  bundleComponents: { type: "array", items: str, description: "distinct product names, only when pack=bundle" },
  labelTiles: { type: "array", items: { type: "number" } },
  labelTileKinds: { type: "array", items: { type: "string", enum: ["pack_photo", "spec_graphic"] } },
  frontTile: nullableNum,
  reason: str,
};

/** legacy certs_llm.js SCHEMA, minus fssaiLicence: the pack read in call 2 owns licences. */
const CLAIMS_PROPS = {
  productTesting: {
    type: "array",
    description: "tests the FINISHED product is said to undergo",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: [
            "third_party_lab", "heavy_metals", "banned_substances", "microbial", "potency_assay",
            "protein_accuracy", "protein_spiking", "aflatoxin", "pesticide", "solvent_residue",
            "allergen", "identity_dna", "adulteration", "radiation", "stability_shelf_life", "other",
          ],
        },
        programme: { ...nullableStr, description: "named certifier or accredited lab if any: Informed Sport, Informed Choice, NSF Certified for Sport, Labdoor, USP Verified, NABL-accredited lab, Eurofins, SGS, Intertek, AOAC method" },
        everyBatch: { type: "boolean", description: "true only if the text says every batch / each lot" },
        quote: { ...str, description: "short verbatim snippet, max 15 words" },
      },
      required: ["kind", "programme", "everyBatch", "quote"],
    },
  },
  purityClaims: { type: "array", description: "'free from' statements, NOT tests", items: str },
  facilityOrLicence: {
    type: "array",
    description: "about the factory, the lab or the legal listing — never evidence the product was tested",
    items: { type: "string", enum: ["fssai", "ayush", "gmp", "cgmp", "haccp", "iso_9001", "iso_22000", "iso_17025", "nabl_accredited_lab", "us_fda_registered", "usda_organic", "india_organic", "halal", "kosher", "other"] },
  },
  dietFlags: {
    type: "array",
    items: { type: "string", enum: ["vegan", "vegetarian", "gluten_free", "sugar_free", "non_gmo", "dairy_free", "lactose_free", "soy_free", "nut_free", "palm_oil_free", "halal", "kosher", "no_artificial_additives"] },
  },
  ingredientLevel: { type: "array", description: "certifications belonging to an ingredient, not the product", items: str },
};

/** legacy extract2.js FACTS_SCHEMA */
const FACTS_PROPS = {
  brand: str,
  productName: str,
  formFactor: { ...nullableStr, description: "capsule | tablet | powder | gummy | sachet | effervescent | liquid | softgel | stick | bar | other" },
  servingSize: nullableStr,
  servingsPerContainer: nullableNum,
  netQuantity: nullableStr,
  doseDirections: nullableStr,
  rows: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        role: { type: "string", enum: ["active", "macro", "excipient"] },
        printedName: str,
        canonical: str,
        amount: nullableNum,
        unit: nullableStr,
        amountBasis: { type: "string", enum: ["elemental", "compound", "unknown"] },
        form: nullableStr,
        standardization: nullableStr,
        isPartOfBlend: { type: "boolean" },
        blendName: nullableStr,
        blendTotalMg: nullableNum,
        source: { type: "string", enum: ["label_image", "description", "title"] },
      },
      required: ["role", "printedName", "canonical", "amount", "unit", "amountBasis", "form", "standardization", "isPartOfBlend", "blendName", "blendTotalMg", "source"],
    },
  },
  confidence: { type: "number" },
  notes: str,
};

/** legacy marks.js SCHEMA */
const MARKS_PROPS = {
  testingMarks: {
    type: "array",
    description: "printed testing claims and third-party programmes",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        mark: { ...str, description: "as printed" },
        kind: { type: "string", enum: ["third_party_lab", "heavy_metals", "banned_substances", "microbial", "potency_assay", "protein_spiking", "pesticide", "allergen", "other"] },
        legible: { type: "boolean" },
      },
      required: ["mark", "kind", "legible"],
    },
  },
  certificationMarks: {
    type: "array",
    description: "facility, licence and standards marks",
    items: { type: "object", additionalProperties: false, properties: { mark: str, legible: { type: "boolean" } }, required: ["mark", "legible"] },
  },
  dietMarks: { type: "array", items: { type: "string", enum: ["vegetarian_green_dot", "non_vegetarian_brown_dot", "vegan", "gluten_free", "sugar_free", "halal", "kosher", "non_gmo", "organic"] } },
  fssaiLicences: {
    type: "array",
    description: "Indian packs usually print two, the marketer's and the manufacturer's. Capture each with whose it is.",
    items: {
      type: "object",
      additionalProperties: false,
      properties: { number: { ...str, description: "digits only, normally 14" }, role: { type: "string", enum: ["marketed_by", "manufactured_by", "packed_by", "imported_by", "unknown"] } },
      required: ["number", "role"],
    },
  },
  allergens: {
    type: "object",
    additionalProperties: false,
    description: "the pack's allergen statement, split by what it actually says",
    properties: {
      contains: { type: "array", description: "allergens the product itself contains", items: { type: "string", enum: ALLERGENS } },
      mayContainTraces: { type: "array", description: "cross-contamination from a shared facility only", items: { type: "string", enum: ALLERGENS } },
      freeFrom: { type: "array", description: "allergens the pack explicitly claims to be free from", items: str },
      statement: { ...nullableStr, description: "the allergen sentence verbatim, max 200 chars" },
    },
    required: ["contains", "mayContainTraces", "freeFrom", "statement"],
  },
  otherPackMarks: { type: "array", items: str },
  illegibleBadgeCount: { type: "number", description: "badges you can see but cannot read" },
};

const strictObject = (props) => ({
  type: "object",
  additionalProperties: false,
  properties: props,
  required: Object.keys(props),
});

/** Call 1: classify the listing and judge the claims its own text makes. */
export const call1 = {
  name: "classify_listing",
  system: `${CLASSIFY_SYS}\n\n${CLAIMS_SYS}`,
  schema: strictObject({ ...CLASSIFY_PROPS, ...CLAIMS_PROPS }),
};

/** Call 2: read the facts panel and the marks printed on the same pack photos. */
export const call2 = {
  name: "supplement_facts",
  system: `${FACTS_SYS}\n\n${MARKS_SYS}`,
  schema: strictObject({ ...FACTS_PROPS, ...MARKS_PROPS }),
};

export const CLASSIFY_KEYS = Object.keys(CLASSIFY_PROPS);
export const CLAIMS_KEYS = Object.keys(CLAIMS_PROPS);
export const FACTS_KEYS = Object.keys(FACTS_PROPS);
export const MARKS_KEYS = Object.keys(MARKS_PROPS);

// Split one merged call output back into its two record sections.
export const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in (obj || {})).map((k) => [k, obj[k]]));
