# Phase 2: Barcode logging (packaged food)

Status: noted (2026-09-12). Nothing built. Not started, not scheduled.

## What a barcode is

An EAN-13 / UPC number, nothing else. Ingredients and nutrition come from a
database lookup keyed on that number. The scanner is a shortcut around name
search for packaged food; it is a nutrition input method, not a sensor.

## Goal

Scan a packet → resolve product → land in the existing `log_meal` path as a
catalog-matched line with a known serving size. Same confirm sheet, same row
shape (`catalogId · grams · source · confidence`), `source = "barcode"`.

## India reality (drives the design)

- Open Food Facts India is ~60k products, mostly big brands. Regional and small
  brands miss often. No good paid Indian barcode DB (Nutritionix/FatSecret are
  US-heavy).
- Loose food (dal, sabzi, street food) has no barcode. India stays mostly a
  name-search and photo problem; barcode covers packaged snacks and drinks.
- So the miss path matters more than the hit path: scan → miss → user photographs
  the label → OCR the nutrition table (the existing photo parse call, vision) →
  store under that barcode for everyone. HealthifyMe / Cronometer built their
  catalogs this way.

## Backend

### Tool: `nutrition_scan_barcode`

- Param: `barcode` (string, digits only, EAN-8/EAN-13/UPC-A; description carries the
  format rule). Optional `labelImageUrl` for the miss path.
- Routing prose only: use when the user scanned or typed a packet barcode; the result
  is then logged via `nutrition_log_meal` with the returned `catalogId`, never
  re-parsed from text.
- Handler: local lookup first (`catalog` rows keyed by barcode) → Open Food Facts
  `GET /api/v2/product/{barcode}.json` → cache the hit as a catalog entry with brand,
  serving size, per-100g values, `source = "off"` → return
  `{ catalogId, name, brand, servingG, packageG?, per100g }`.
- Miss: if `labelImageUrl` present, run the label through the photo parse call
  (nutrition-table OCR, per-100g + serving) and create the catalog entry flagged
  `estimated`/`source = "label_ocr"`; else return a self-correcting rejection: "not
  found, send a photo of the nutrition label with the same barcode" and enqueue the
  barcode in the gap queue (`nutrition-module.md` §1).
- Storage: additive column `barcode` on the catalog table (unique, nullable) plus
  `source` value for OFF / label OCR rows. Repricing rule from §1 applies when a
  curated entry later replaces an OCR one.

### HTTP

`GET /nutrition/barcode/:code` for the mobile quick capture (same handler as the
tool, no LLM in the path on a hit). Miss with label photo posts through the existing
`POST /nutrition/photo` then `/meals/parse` with `barcode` attached.

## UI: quick capture

- Log sheet gains a third button next to Photo / Text: **Scan**. Camera view with
  barcode detection (`expo-camera` / ML Kit), one call on detection.
- Hit → goes straight to the confirm sheet with the product as one line, serving
  size prefilled, portion chips ("1 serving", "half pack", "whole pack", grams).
- Miss → inline prompt "Not in our list yet. Snap the nutrition label" → same photo
  flow, then confirm sheet. Never a dead end.
- Frontend handoff: add the Scan entry to the Log sheet in `frontend-handoff/SCREENS.md`
  and the endpoint to `frontend-handoff/api` when this is scheduled (see
  `project_frontend_handoff_folder` rule: run `npm run handoff` after).

## Open

- Open Food Facts licence (ODbL) implications for caching rows in our catalog.
- Whether label-OCR rows are user-private until a second user confirms them.
- Nutri-Score / additive flags: skip for v1, it is a lookup on the same data later.
