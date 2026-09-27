# Phase 2 — Indian Supplements Catalog: History, Issues, Decisions

Source: session `8c294197-9dbc-439f-95f3-171c3613b305` (2026-09-14 to 2026-09-27), worktree
`.claude/worktrees/phase-2` (branch `phase-2`), plan `plans/phase-2/supplements-products-india.md`.
Nothing has ever been committed; all data is JSON under `scripts/e2e/out/products/`.

## Timeline

1. **2026-09-14 (session 1):** Started worktree, decided Shopify `/products.json` is directly
   scrapable, researched Indian D2C brands, planned a verify-pass-first workflow. User rule:
   "do not spend a lot until you know the data is clean"; verify pass required before bulk.
2. Built `fetch_shopify.js` (22 stores → 3,699 products), `inspect.js` classifier, a 45-item
   stratified verify sample, `verify/extract2.js` two-call OpenAI extractor (classify + facts)
   using a `sharp` contact-sheet grid so one call covers all ~9 images instead of sending 3 raw.
3. Verify pass validated: round-2 on 45 items ≈$0.10, all non-supplements/bundles caught,
   resolution against `supp_ingredients` slugs worked via LLM candidate-pick. Built an Artifact
   to show results with images; fixed a DOMContentLoaded bug that made filter buttons dead.
4. **2026-09-14 (session 2):** User approved bulk ("yeah okay fo ahead"). Ran the two-call
   extractor over all 3,252 filtered Shopify rows. Hit memory kills, JSON truncation, batch
   plumbing bugs. Landed at $7.62 spend (quoted ~$5). Wrote `clean.js` to post-process into
   `bulk/clean.json`/`rejects.json`. User deferred DB slug-linking ("we can have these as
   intelligent searches... we'll link them later on") and deferred a Haiku review pass.
5. **2026-09-23:** A separate cleanup session ran a batch `git worktree remove --force` over
   three worktrees (api-logging, phase-2, oura-integration) without checking each one's status
   individually. This deleted the entire phase-2 worktree — all scripts and all generated data
   (3,252 LLM extractions, the full Shopify pull), ~$8 of paid API spend, unrecoverable (no
   Trash, no Time Machine on this machine).
6. **2026-09-24-25:** Discovery of the deletion. A Sonnet agent was run over old session
   transcripts to reconstruct scripts from heredocs (the pre-patch version of `extract2.js` came
   back this way and had to be re-patched by hand). CLAUDE.md updated with a worktree register
   and deletion protocol; two memory files written.
7. Data was re-fetched and re-extracted from scratch. Model chosen this time: after user
   confusion ("gpt-6-sol" believed cheaper) pricing was actually measured from
   developers.openai.com and `gpt-6-luna` ($0.10/$0.50 per Mtok) used, matching `gpt-6-sol`
   ($2/$10) on a 20-product A/B at 1/20th the cost.
8. Replaced the unreliable "review" pass (one model judging another's extraction, which
   hallucinated fault "corrections") with independent re-extraction + code comparison
   (three-read majority-vote adjudication in `adjudicate.js`).
9. Built the Amazon side: `amazon_brand.js` (Apify `junglee/amazon-crawler`, brand-filtered
   search, detached+polled because of the 300s sync limit), `amazon_prepare.js`,
   `amazon_clean.js`, `merge.js` (Shopify+Amazon dedup by token Jaccard + dose-key), `amazon_fill.js`
   (use Amazon photos to rescue Shopify items with unreadable labels), `amazon_price.js` (live
   price when every Shopify variant is sold out).
10. Certifications/testing: started with a regex claim scanner (`certs.js`, ~75% precise per
    user challenge), replaced with an LLM judge (`certs_llm.js`) scoped to catalog keys with
    windowed excerpts. Added a separate vision pass (`marks.js`) reading marks physically
    printed on the pack (FSSAI licences, testing marks, diet marks, allergens) — proved richer
    than listing text (Naturyz: GMP/HACCP/FSSAI/Dope Free on pack, zero mentions in 1,833 chars
    of description).
11. **2026-09-26/27:** Discovered pack-marks and judged-claims data existed on disk but had
    never been wired into `clean.js`/`amazon_clean.js`/the catalog. Fixed. Found and fixed a
    "brandOf" fallback bug that produced garbage concatenated brand names for new stores.
12. Root-caused a "which values are wrong" question by reading a label by eye: neither model
    read was wrong — the brand's physical pack numbers differ from its own published spec
    graphic. This produced the single biggest quality rule of the whole project: photographed
    pack always wins over a flat rendered spec graphic. Reduced withheld/unverified amounts
    from 121 to 2.
13. Added a "pick the ingredients image, not the product image" grid-pick LLM pass; verified
    (rather than assumed) OpenAI's vision patch-tiling limit before deciding whether to bump
    image width (1600px was already at the 2,500-patch cap; reverted a pointless bump).
14. User scoped bars: protein bars with a stated dose are supplements (`formFactor: "bar"`,
    `isFoodForm: true`); energy/snack/millet bars are not, even with a nutrition panel. Pulled
    Yoga Bar, Max Protein, RiteBite, SuperYou. Added 5 more brands (Be Wellness, Ace Blend
    already had, The Stack Club, Decode Age, Cosmix, Autoimmunity, Pure Nutrition, Traya, Nveda,
    Gynoveda, Melblok).
15. **2026-09-27 end state:** catalog 2,771 products, 54 brands (35 store-sourced, 19
    Amazon-only). Conversation turned to architecture: catalog should live in the DB as its own
    table, separate from user stack rows; user wants a *new, separate repo* with the pipeline,
    a schema, an import job, and a viewer, syncing to prod rather than the pipeline writing prod
    directly. User asked for the conversation ID so Fable could set up that repo from a
    from-scratch understanding of this history — which is this report's origin.

## Issues table

| # | Problem | Root cause | Fix / decision | Lesson for rebuild |
|---|---|---|---|---|
| 1 | `OPENAI_API_KEY` missing in scripts | Worktree has no `.env` | Env loader walks up to main checkout's `.env`/`.env.local` | New repo needs its own resilient env-loading, not path-walking hacks |
| 2 | `db.execute is not a function` | Wrong import shape | `const { db } = require(...)` | — |
| 3 | `DATABASE_URL_V2 not set` | Not exported in worktree shell | Export from main checkout before running resolve scripts | New repo's DB access should be explicit/config-driven, not env-inherited |
| 4 | Apify token read as empty | `grep .env*` matched `.env.example` first | Grep `.env` only | Be exact with glob patterns near secrets |
| 5 | False slug matches (sodium→iron, leucine→glycine, fat→calcium) | Words/fuzzy text-match tier alone is untrustworthy for short ingredient names | LLM candidate-pick from top-5 matcher candidates (`resolve2.js`); macros tagged so they never hit the matcher | Never trust fuzzy matching alone for short technical terms |
| 6 | Blend components collapsed into one row (Miduty) | Extraction prompt didn't force per-component expansion | Prompt rule: expand every blend component | Ingredient row model must force explicit `isPartOfBlend`/`blendName` breakdown |
| 7 | Protein line tagged as macro, leaving no active row | Prompt didn't flag protein powders' headline nutrient as active | Prompt patch marks headline nutrient active | — |
| 8 | Only 3 of ~9 images sent per product (missed label images) | Sending raw images one by one hits a 2-3 call budget ceiling | Contact-sheet grid (sharp, 320px tiles) so ONE call covers all images, LLM picks which tiles are labels | Always give the model the whole image set at low cost before asking it to pick |
| 9 | Round-2 artifact filter buttons dead | `<script>` ran before DOM existed | Wrapped in `DOMContentLoaded` | — |
| 10 | Only 2 of 4 label tiles sent (Fast&Up panel missed) | Hardcoded slice(0,2) | `labelTiles.slice(0,4)` | Cap should track actual max panels found in the field, not be arbitrary |
| 11 | Amino-acid group totals copied onto every amino individually | No rule distinguishing group heading vs member rows | Prompt rule: one heading row with the total, members get `amount: null, isPartOfBlend: true` | — |
| 12 | Classify and Facts disagreed on container/unit count | Two separate calls, no reconciliation | `clean.js`: facts-derived count wins over classify's guess | Reconcile at the post-processing layer, not by hoping the model self-corrects |
| 13 | OZiva bundle false positive | Image-led classification overrode explicit title/variant evidence | Prompt rule ignored by model → code-level demotion logic added (require every bundleComponent named in title/variant, else force `single`) | Code-level guardrails needed where the model systematically ignores a prompt rule |
| 14 | JSON truncation ("Unterminated string...") on long whey labels | `max_completion_tokens` too low (3000) | Raised to 8000 | Size output token budget to the worst case (dense ingredient panels), not the median |
| 15 | Bulk process killed 3x, "low on memory" | sharp caching + machine's own memory pressure (Rize/Chrome) | `sharp.cache(false); sharp.concurrency(1)`; fresh-process batches of 150; nohup/disown | Long LLM batch jobs need to survive process/session restarts by construction |
| 16 | Batch loop `\| head -1` closed the pipe, SIGPIPE-killed node early | Piping long-running process output through `head` | Write to a file, read head/tail after | Never pipe a long-lived background process straight into `head` |
| 17 | `pkill -f supp-bulk-loop` also killed the monitoring process | Command-text pattern match too broad | Re-armed monitor with different, non-matching text | Name background jobs so kill patterns can't collide with your own tooling |
| 18 | Cost overshoot ($7.62 actual vs ~$5 quoted) | Quote didn't fully account for per-image/label-tile token cost at scale | Reported actual honestly | Quote ranges, verify via a subsample before committing to a bulk number |
| 19 | Boldfit.com Shopify store yields zero real supplements | The store only sells gear (bands/grippers) | Confirmed by direct inspection, not treated as a pipeline bug; flagged for Amazon-only coverage | Verify "0 results" claims by inspecting the source before assuming a bug |
| 20 | No-label extractions produced junk (Cureveda "Heart Hugs") | Facts model guessed from description alone when no label photo existed | `clean.js` tags `unverified_no_label`; flagged for Amazon verification, not trusted as-is | Track provenance/verification class per record, don't silently accept guesses |
| 21 | `gpt-5.4-mini` hallucinated label "corrections" (10/12 flagged "major" were invented) | Reviewer model asked to find faults with a schema that forces a non-null "label" field, zero reasoning budget | Abandoned mini as reviewer entirely | Never force a model to output a finding when it may have none — schema design creates the hallucination |
| 22 | **Entire worktree + all data deleted** | 2026-09-23 cleanup session ran `git worktree remove --force` in a loop over 3 worktrees without individually checking `git status --porcelain --ignored` on each first | Not recoverable; rebuilt scripts from session transcript heredocs, regenerated all data | Never batch-remove worktrees; write down worktree ownership/purpose/delete-condition in CLAUDE.md (now done); copy expensive generated output outside the worktree the day it's produced |
| 23 | Recovered `extract2.js` was the pre-patch version | Reconstruction pulled the earliest heredoc it found, missing later inline edits | Re-applied all documented patches by hand | Recovery-from-transcript needs to walk forward through ALL edits, not stop at first match |
| 24 | `review.js` env path wrong after recovery | Hardcoded relative path assumption | Root-walking env loader | — |
| 25 | `sharp` missing after rebuild | Not installed in fresh worktree | `npm install sharp --no-save --no-package-lock` in main checkout, symlinked into worktree | — |
| 26 | Low-res label detection broken on rebuild | Grid tiles carry only `{index, src}`, no width | Look width up from `p.images` by matching `src` | — |
| 27 | `review.js` (model-judges-model) flagged 744 "majors", mostly false | Prompt/schema forces fault-finding, zero reasoning effort, no independent evidence | Replaced entirely with independent re-extraction + code comparison (adjudication) | Verification-by-independent-measurement beats verification-by-critique |
| 28 | `adjudicate.js` counted 1,658 rows "unresolved" | Rows simply absent from one read were treated as disputes instead of naming/coverage differences | Treat as `agreement: "1/1"` (single-read corroboration), not a conflict | Missing data ≠ disagreement; distinguish "no signal" from "conflicting signal" |
| 29 | `netQuantity` parsing wrong 4 iterations running | Real-world label strings vary wildly ("Pack of 60's", "60N Tablets", "Net Wt: 250g", "5 x 33.8g = 169g") | Iteratively built `splitNetQty()` with unit/lead-strip regexes | Budget multiple iterations for real-world label string parsing; no single regex survives contact |
| 30 | Artifact images blank, then hit 255-file publish limit (291 requested) | External image hosts blocked by artifact CSP; too many files packaged | Embedded/packaged images; user said "just a few is fine" → reduced to 24 products | Design demo artifacts for a small representative sample, not the full catalog |
| 31 | Amazon brand filter returned 0 for Plix/Bhumija/Bodywise | Never checked Amazon's actual seller/brand strings before filtering | User caught it directly; probed and found real strings (PLIX - THE PLANT FIX, BHUMIJA LIFESCIENCES, Be Bodywise); also found HealthKart is a retailer not a brand (products under HK Vitals) | Verify the actual brand facet values on the target platform before filtering by assumed name |
| 32 | `amazon_prepare.js` read its own prior output files as if they were fresh brand pulls (twice) | No exclusion of its own generated filenames | Regex-based self-read guard | Pipeline stages that write and read the same directory need an explicit filename allowlist/denylist |
| 33 | Amazon `/stores/` brand-page URL rejected by crawler | Crawler only accepts `/s?k=` search and `/dp/` product URLs | Switched to brand-filtered search `&rh=p_89%3A<Brand>` | Check the tool's accepted URL shapes before building around a plausible-looking one |
| 34 | Apify sync endpoint 300s timeout | Long brand crawls exceed sync limit | Start detached, poll for completion | Any external job with unbounded run time needs async/poll from the start |
| 35 | Serial brand pulls projected at ~4 hours | No parallelism used | Ran in parallel (account allows 32 concurrent) → ~20 minutes | Check account concurrency limits before assuming serial is required |
| 36 | Ayurvedic juices misclassified as not_supplement | No India-specific rule for dose-based ayurvedic liquids (ras, kwath, kadha, chyawanprash-style pastes) | Added explicit classify rule: judge by measured daily dose, not container type; seeds/nuts/flours/ghee/honey-as-food stay excluded | Region-specific product conventions need explicit rules, not generic heuristics |
| 37 | Amazon-fill matched wrong products (Cureveda "LiverLoyal"→Gold Turmeric; "PilesPack"→Weight Gut) | Squashed brand names tokenize as one indistinguishable word | camelCase split + plural stemming + require ≥2 shared distinctive tokens; first fix over-corrected (dropped correct matches), 2-token rule fixed both directions | Token-matching thresholds need testing against both false positives and false negatives before locking in |
| 38 | Regex certification-claim scan only ~75% precise | Regex can't distinguish product-level claims from ingredient-level, or genuine testing from "free from" marketing | User challenged directly ("should we trust the script or have an llm do this?"); replaced with LLM judge (`certs_llm.js`) with a 15-kind schema | Regex is fine for candidate detection, not for adjudicating claim semantics |
| 39 | Claim judge wasted 371 calls on already-rejected rows, lost 115 listings to a 320-char sentence-window rule | No scoping to valid catalog keys; excerpt window too short for real claim sentences | User caught it ("the script is not reliable, how many of the listings are valid products"); scoped to catalog keys only, switched to a windowed excerpt around trigger words instead of fixed sentence length | Scope any LLM pass to the currently-valid record set explicitly; don't silently process rejects |
| 40 | Reported Apify spend as $9.18 when the account actually showed $11.46 | Figure only summed logged/tracked runs, missed some | Corrected once discrepancy noticed | Track spend from the provider's own dashboard/API, not a self-maintained running log |
| 41 | New stores missing brand names, `brandOf()` fell back to concatenated haystack text ("CosMix CosMix Bring Me Bliss") | `brandOf` signature didn't take vendor/labelBrand cleanly; STORE_BRAND map not updated for new stores | Fixed signature to accept `vendor`/`labelBrand` separately; added missing store entries; brand count corrected from bogus 127 down to 47 (later 54) | Any hardcoded per-source map (STORE_BRAND, BRAND_NAME) must be updated in lockstep with new source additions, or add a loud fallback failure instead of a silent garbage one |
| 42 | Background wait/monitor loops repeatedly killed for "low memory" | Machine memory pressure unrelated to the jobs themselves | Re-armed with longer sleep intervals; underlying jobs unaffected | Distinguish monitor-process kills from actual job failures before re-running expensive work |
| 43 | Pack-marks and LLM-judged claims data existed on disk but were never merged into the catalog | `clean.js`/`amazon_clean.js` were never updated after `marks.js`/`certs_llm.js` were built | Wired `packMarks`, `packTestingMarks`, `certificationsRead`, `allergens`, etc. into both cleaners | A generated-artifact pipeline needs an explicit "wire into catalog" step tracked as a task, not assumed to happen automatically |
| 44 | Amazon pack-marks lookup silently under-matched (1,988 of 2,373) | Marks files keyed `amazon.in__<ASIN>`, lookup used bare ASIN | Introduced a `ck` (catalog key) for consistent keying | Keying convention must be identical across every stage that writes/reads the same entity |
| 45 | `adjudicate.js` only used a 323-product partial second read (`bulk/recheck`), ignoring the full 3,320-product `bulk/read2` that had already been paid for | Directory list in the script was never updated after `read2` was produced | Added `r2b`, unioned both dirs → 2,245 products adjudicated | Verify a paid-for dataset is actually being consumed downstream before assuming a step is complete |
| 46 | High-effort tiebreak had covered only 58 of 448 disputed products | Ran before the full second read existed | Re-ran on 390 remaining disputes ($1.354); unresolved fell 1,277→479 | Sequence dependent LLM passes correctly or re-run once upstream data is complete |
| 47 | Extractor "not found" when invoked from products root | Script actually lives in `verify/` subfolder | Ran from correct cwd with adjusted relative paths | Document canonical invocation directory per script |
| 48 | Assumed "2000px is the API's own tiling/output limit" without checking | Assumption carried over from GPT-4o-era docs | User challenged ("what api?"); verified against real docs: 2,500-patch budget = exactly 1600×1600, so 1600 was already at cap; reverted the pointless bump | Verify vendor technical limits against current docs before acting on them, especially when they'd trigger a costly re-run |
| 49 | Percentages on Indian labels ("Dates 7%") converted to grams by the model | No rule against unit conversion; model inferred grams from serving size | Explicit rule: report as printed (amount 7, unit "%"), never convert | Extraction should preserve what's printed, not derive/compute values the model isn't authoritative to compute |
| 50 | `adjudicate.js` crash `Cannot read properties of null (reading 'get')` | Missing null guards on lookups from reads that might not exist for a given key | `m2 && m2.get(name)` etc.; moved a `const` above an early-continue guard | Guard every optional multi-source lookup |
| 51 | Chained `sleep 120 && tail ...` blocked by the harness | Harness disallows long sleep chains in foreground bash | Used `run_in_background: true` or an `until` polling loop | Standing rule for this environment now |
| 52 | `clean.js` read only `bulk/extracted`, missing 481+248 newly pulled products (brand count stuck at 47) | Extraction moved to a new dir (`read3`) but `clean.js` source list wasn't updated | Unioned `extracted` + `read3` via a `SRC` Map, `read3` winning on conflicts | Any post-processor's source-directory list must be a single source of truth kept in sync with the extractor's actual output location |
| 53 | Bars extracted with `formFactor: "other"` | Schema enum description never listed `bar` as a valid value | Added `bar` to the enum description and formFactor list, re-ran 36 bar-titled rows with `--force` | Schema enums are prose to the model — omissions are silent misclassifications, not errors |
| 54 | `isFoodForm` patch applied at the wrong anchor text, silently no-op | Anchor string wasn't unique/didn't exist verbatim | Found the real anchor via grep in both files and re-patched | Verify a patch's anchor actually matches before trusting a "successful" edit |
| 55 | Amazon bar-recheck list came back empty | Filename convention mismatch: files are `amazon.in__<ASIN>.json`, but `extract_input.json` rows carry a bare `id` | Parsed ASIN out of filename via basename split | Keep entity-id conventions consistent across all pipeline files, or normalize at the boundary |
| 56 | Cost misattributed to "today" | A run straddled midnight | Corrected framing to "this session, ~$4.50" | Attribute cost by run/session, not by calendar day, for long-running jobs |
| 57 | Boldfit (431→0) and Sirona (102→0) looked like pipeline bugs | Investigated directly: Boldfit's store sells bands/grippers/sleeves, Sirona is period care — genuinely zero supplements | Confirmed correct, not a bug | Investigate suspicious zero-counts by inspecting the source, don't assume the pipeline broke |
| 58 | Ace Blend zero-image products looked like a bug | They are "🎁 Starter 5" promo listings with no photos; real SKUs covered elsewhere | Confirmed correct | Same as above |
| 59 | **The core quality bug of the whole project**: some products' extracted values looked "wrong" between reads | Root cause was NOT extraction error — brands publish a flat "spec graphic" for the online listing whose numbers genuinely differ from the physical pack they ship (verified by user reading actual label photos) | New rule: photographed pack always wins over a spec graphic; ordered pack-photos first, `labelTileKinds` classification added (`pack_photo` vs `spec_graphic`) | The label truth-source itself can be ambiguous on the source platform — a pipeline needs an explicit precedence rule, verified against a real physical product, not assumed |

## User scope decisions (verbatim where available)

- **What counts as a supplement:** "is whey protein a supplement in our case?" → yes. Ayurvedic
  drinkable preparations taken as a measured daily dose (juice, ras, kwath, kadha, syrup, tonic,
  asava, arishta, shot, chyawanprash-style paste) count — "yeah they count" — judged by dose, not
  container; seeds/nuts/flours/oats/ghee/honey sold as food stay excluded.
- **Bars:** "yoga bar has protein powder and all should be store protein bars as supplements?"
  → dosed protein bars ARE supplements (`formFactor: "bar"`); "yeah correct these should not be
  added as supplementsm that's stupid yeah" — energy/snack/millet/meal bars are NOT, even with a
  nutrition panel, because they have no stated active dose.
- **Packs/bundles:** store singles only; drop bundles of different products and multipacks;
  value packs (same product, bigger size) are kept. "Pack of 30 sachets/sticks" is treated as a
  single with `unitsInContainer=30`. "if they have packs, they'll have single products as well
  no? in that case we dont have to store the packs right?" — confirmed, singles preferred.
- **Verify-before-spend rule:** "you need to first do a verify pass, create a folder for this and
  write all the scripts and make sure things are working... and get it approved by me, then you
  can go ahead with the actual flow... do not spend a lot until you know the data is clean."
- **Sonnet agents for verification:** "you can run multiple sonnet agents to verify stuff but one
  at a time."
- **DB linking deferred:** "nah not needed now, for now, we can have these as intelligent
  searches, so that the llm gets the values / we'll link them later on."
- **No DB access from this worktree (standing constraint, 2026-09-25):** "note that in this
  worktree you should not touch the db at all, only json files."
- **Reviews backfill declined:** "no need for the reviews, can do 1, what's 2" — Amazon
  ratings/reviews lookup for ~2,100 Shopify-only products (~$6) was explicitly skipped.
- **Fix, don't leave unverified:** "whats the point in keeping it unverified, it needs to be
  fixed right?" — drove the pack-authoritative rule and the ingredients-image grid pick pass.
- **Certification method:** "wait should we trust the script on have an llm do this?" → moved
  regex claim scanner to an LLM judge; "yeah go ahead, and pass as small batches, dont give a lot
  for the llm to do / anyways the prompt would be cached"; "make sure you handle all the
  different testing and all."
- **Allergens:** "yeah add it, go for it."
- **Brand additions named directly by user:** "Be wellness / aceblend / thestack club / decode
  age", "cosmix / autoimmunity / wellbeing nutirtion / it's be."
- **Answers must be super short** (standing, repeated across the whole session; enforced from
  CLAUDE.md/memory).
- **Artifact scope reduced:** "dude just a few for reference is fine wtf" (100 products → 24).
- **Amazon brand pulls:** "yeah can you first try running for a brand and see if the results are
  good?" before running the rest; "so you're suggesting no cap?" discussion led to a sold-out
  early-stop threshold instead of an arbitrary item cap.
- **Don't commit:** repeated throughout — "Nothing is committed; user said 'don't commit'."
- **Final scope hand-off:** catalog build declared essentially finished; user pivoted to wanting
  a new, separate repo with the pipeline + schema + viewer + DB sync, explicitly kept separate
  from the current worktree ("catalog should be a different table obviously").

## Costs seen

- **OpenAI, verify pass (45 items, round 2):** ≈$0.10.
- **OpenAI, first bulk run (3,252 Shopify rows):** quoted ~$5, actual **$7.62**.
- **Model pricing per 1M tokens** (fetched from developers.openai.com/api/docs/pricing):
  `gpt-6-luna` $0.10/$0.50 (settled default), `gpt-5.6-luna` $0.20/$1.20 (earlier default),
  `gpt-6-sol` $2/$10, `gpt-6-astra` $10/$50, `gpt-5.6-sol` $4/$20, `gpt-5.4-mini` $0.75/$4.50.
  `gpt-6-luna` matched `gpt-6-sol` on every active ingredient in a 20-product A/B at 1/20 cost.
- **Apify** (`junglee/amazon-crawler`, PAY_PER_EVENT): ~$0.004/product with details, ~$0.0032
  search-only. Account: Starter plan, $29/month credit, 32 concurrent jobs, 64GB. Spend reached
  **$9.18 self-tracked / actual $11.46** per the account dashboard (discrepancy: self-tracking
  missed some runs) — ended session at **$11.46 of $29 credit**.
- **Read3 full re-extraction pass:** $3.598. High-effort tiebreak on 390 disputed products:
  $1.354. Session total ≈$4.50 OpenAI for the final (2026-09-27) session.
- **Cumulative OpenAI spend across the whole project:** roughly **$12** (per the 2026-09-26
  summary) before the final session's additional ~$4.50.
- Amazon rating/review lookup for the ~2,100 Shopify-only products with no reviews: estimated
  **~$6**, declined by the user for now.

## Open / pending items at end of transcript (2026-09-27)

- 324 catalog products still not `label_read` (205 with no label tile at all): combo/offer
  listings, lifestyle-only photos, panels printed per-100g or under 800px — "not fixable by
  another LLM pass on the same images."
- ~2,100 products have no rating/reviews (Amazon-only field); ~$6 Amazon lookup declined for now.
- `amazon_brand.js`'s `STOP_OOS = 0.34` sold-out early-stop threshold is still hardcoded, not
  exposed as a flag; headless-brand Amazon pulls were never re-run "deeper."
- `marks.js` and `certs_llm.js` need re-running over products added in the final session (Pure
  Nutrition, Max Protein, Traya, Yoga Bar, SuperYou, Nveda, Gynoveda, Melblok, plus re-read
  bars) — they have no pack-marks or judged-claims read yet.
- **Unanswered design question that determines the DB schema:** does the LLM filter products by
  ingredient + dose (needs ingredient rows indexed on canonical + amount), or pick a product
  first and read its rows back (rows could just be a JSON column)?
- Storage/schema work is explicitly **out of scope for this worktree** — deferred to the planned
  new repo.
- Nothing in phase-2 has been committed; user has repeatedly said not to.
- Final catalog state: **2,771 products, 54 brands** (35 store-sourced, 19 Amazon-only).
  Verification breakdown: label_read 2,426, unverified_title_only 104, unverified_no_label 130,
  unverified_low_confidence 91, unverified_low_res 19. Certifications: 2,371 pack reads, 966
  with a testing mark, 1,408 certification marks, 1,042 FSSAI licences, 2,371 allergen
  statements, 283 with product-level testing claimed in text. 28 bars flagged
  (`isFoodForm: true`). Rows: 33,726 agreed 2/2, 14 settled 2/3, 1,054 pack-authoritative
  (pack photo overrode a spec graphic), 12 unresolved.

## Planned new repo / DB schema / sync design (discussed, not yet built)

- User: "yo so should this table be in this db, yes right? / also how do we manage this, i'm
  thinking of moving this to a different repo with all the modules and system to manage the
  supplements, and a viewer as well / it can push to the prod db or sync"; "yeah catalog should
  be a different table obviously."
- Agreed direction (assistant's recommendation, accepted by user):
  - Separate **reference-data tables**: `supplement_products`, `product_ingredients` (retaining
    per-row `agreement` — "2/2"/"2/3"/"pack"/"1/1" — plus `packOverridden` and
    `amountUnverified` provenance), `product_offers` (price/stock/URL per source, since a
    product can have both a Shopify offer and an Amazon offer).
  - **User stack rows** are separate: an FK into the catalog plus the user's own dose (not a
    copy of catalog data).
  - **Sync via versioned snapshot**, not the pipeline writing prod directly:
    `catalog-v<n>.json` + checksum, imported idempotently by a job, rather than live pipeline
    writes to the production database.
  - The new repo should include the pipeline scripts, the schema, an import job, and a viewer.
  - Explicit reminder embedded in the transcript for whoever builds it: the scripts live at
    `scripts/supplements/products/` and data at `scripts/e2e/out/products/` inside the phase-2
    worktree, **both uncommitted and gitignored** — copy them out before anyone touches or
    removes that worktree again (per the CLAUDE.md worktree-deletion incident, issue #22 above).
  - Open question left for the owner: index for ingredient+dose filtering vs. product-first
    lookup with JSON ingredient rows — this decides the `product_ingredients` shape.

Conversation ID for reference: `8c294197-9dbc-439f-95f3-171c3613b305`.
