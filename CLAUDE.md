# CLAUDE.md

Guidance for AI agents working in this repo. Pairs with `README.md` (which covers
end-user setup/deploy); this file focuses on architecture and conventions for editing code.

## What this is

**Daily Log** — a personal/household food and weight tracker PWA, deployed at
`dailyfoodlog.netlify.app`. Vanilla HTML/CSS/JS frontend (no framework, no build step),
Supabase (Postgres + auth) backend, IndexedDB for local-first storage, Netlify hosting
with Netlify Functions for AI features.

Philosophy: **"Awareness, not restriction."** Some nutrients (sugar, sodium) are shown
as running daily totals with no target, no warning colors — just the number, with an
asterisk when any logged item has an unknown value.

## Architecture

**Local-first.** Reads always come from IndexedDB (instant, offline-safe). Writes go to
IndexedDB immediately, then enqueue a pending op that syncs to Supabase when online.

```
UI (ui.js) ──> Sync (sync.js) ──> IndexedDB (db.js)  [instant, source of truth for reads]
                     │                    │
                     │                    └─> pending queue (op: upsert|delete)
                     └─> Supabase ◄────────────┘  [drained when online; pull merges back]
```

- `js/db.js` — IndexedDB wrapper. Stores: `meals`, `weights`, `foods`, `targets`,
  `notes`, `pending` (sync queue), `meta` (kv), `households`. Exposes `window.DB` with
  `put/get/delete/all/allByIndex`, plus utils `uuid()`, `todayLocalDate()`, `ymd()`,
  `parseYMD()`. Bump `DB_VERSION` only when changing object stores/indexes.
- `js/sync.js` — Supabase client, OTP email auth, household bootstrap, push/pull. Exposes
  `window.Sync` (`saveMeal`, `deleteMeal`, `saveFood`, `saveWeight`, `saveTargets`,
  `saveNote`, `currentUser`, `currentHousehold`, `isAdmin`, etc.). All Supabase reads use
  `select('*')`, so new columns flow through automatically — no column lists to maintain.
- `js/ui.js` — all rendering + event handlers. Defines `$`/`$$` shortcuts and the `STATE`
  object. Exposes `window.UI`.
- `js/parser.js` — natural-language meal parsing. Calls the parse-meal function, then
  resolves each ingredient's macros via: (1) food library, (2) USDA FoodData Central,
  (3) AI estimate fallback. Exposes `window.Parser`.
- `js/label-scanner.js` — camera capture + client-side image compression + call to the
  scan-label function. Exposes `window.LabelScanner.scanLabel()`.
- `js/app.js` — entry point: opens DB, wires the auth screen, calls `Sync.init` → `UI.initUI`.
- `js/config.js` — Supabase URL + anon key (safe to commit; RLS-gated), default targets,
  protein-hit threshold.
- `js/seed.js` — default food library, inserted once when a household's `foods` table is empty.

Module load order in `index.html` matters (globals, no imports): config → db → seed →
sync → parser → label-scanner → ui → app.

## Netlify Functions (`netlify/functions/`)

Both use the Anthropic API with model `claude-haiku-4-5-20251001`, env var
`ANTHROPIC_API_KEY` (already set in Netlify), and share the same CORS/error/`extractJSON`
shape. **When editing one, mirror the conventions in the other.**

- `parse-meal.js` — two modes: `parse` (NL → ingredient list) and `estimate`
  (item → macro estimate). Returns strict JSON.
- `scan-label.js` — vision: base64 label photo → structured nutrition facts.

## Data model

Postgres tables (`supabase/schema.sql`): `foods`, `meals`, `weights`, `targets`, `notes`,
plus household tables. RLS isolates per-user data; `foods` is shared within a household.
Macro columns on `foods`/`meals`: `calories`, `protein_g`, `carbs_g`, `fat_g`, `sugar_g`,
`sodium_mg`. **`sugar_g` and `sodium_mg` are nullable** — `null` means "unknown."

### Migrations

Numbered files in `supabase/`, e.g. `migration-v8-sodium.sql`. **The user runs these
manually in the Supabase SQL Editor** — there is no migration runner. Always write them
idempotent/additive (`add column if not exists`, etc.) and call out in your summary that
the migration must be run before/with the deploy.

## Conventions

- Vanilla DOM only — no framework, no bundler, no npm deps in the frontend. Built-in
  browser APIs (canvas, FileReader, fetch) only.
- `$('#id')` / `$$('.class')` shortcuts; `async/await`; modules attach a single
  `window.X` object at the bottom of the file.
- Match the existing comment-banner style (`/* ==== section ==== */`) and CSS variables
  (`--ink-soft`, `--rule-soft`, `--accent`, `--good`, `--warn`, `--serif`, etc.).
- IDs follow prefixes: edit-food form `ef-*`, custom item `custom-*`, quick-log `q*`.

### The sugar/sodium "awareness" pattern

Sodium was added to mirror sugar **exactly** — if sugar does X, sodium does X. When
touching this kind of nutrient, replicate the pattern in every place: macro-grid mini-stat
with an unknown-asterisk, nullable form inputs (blank → `null`), and every save flow
(serving confirm, custom item, parser save, save-as-meal — where a summed total is `null`
if *any* component is unknown). Sugar additionally has a trend block and tap-for-breakdown
attribution modal; sodium intentionally does not (awareness-only, non-interactive `<div>`).

## Deploying changes

1. If a migration is involved, the user runs it in Supabase SQL Editor first.
2. Commit + push → Netlify auto-deploys frontend and functions (~1 min).
3. **Bump `CACHE_VERSION` in `service-worker.js`** on any frontend change so the PWA
   refreshes cached clients, and add any new `/js/*.js` file to the `APP_SHELL` array.
4. PWA clients may need a full close/reopen (not just re-focus) to pick up the new SW —
   the first launch installs the new worker, the next runs fully fresh.

## Gotchas

- **Never auto-create a household on a Supabase error** — an RLS failure misread as
  "no membership" spawns duplicate households (see `_checkAndCreateHousehold`).
- Nullable macros: distinguish `null`/`undefined` (unknown) from `0` (known zero) when
  summing — `null` triggers the asterisk, `0` does not.
- Dates are local `YYYY-MM-DD` strings via `DB.ymd()`/`parseYMD()`; don't use raw UTC.
- USDA nutrient IDs in `parser.js`: 208 cal, 203 protein, 204 fat, 205 carbs, 269 sugar,
  307 sodium (with branded-data fallbacks like 1008/1093).
