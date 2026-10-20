# Project: murmuration

A local, read-only 3D observatory for one person's X/Twitter history, built on their [Birdclaw](https://github.com/steipete/birdclaw) SQLite archive. Vite + React + three.js app with a Vite-plugin API in dev; production builds are static, from a sanitized export of the dataset. See `contributing.md` for setup and commands.

## Conventions

- use `pnpm`
- use modern TypeScript (ESM only, no CommonJS)
- no semicolons; oxfmt formats (`pnpm fix:format`) and oxlint lints (`pnpm fix:lint`)
- `pnpm test` runs format, lint, types, and unit tests; keep it green
- use `zod` to validate external data
- for local development, use `pnpm dev` and the Portless URL it prints

## Mental model

`~/.birdclaw/birdclaw.sqlite` (read-only) → `src/server/load.ts` (SQL → raw records) → image captions + embeddings (`embed/`, cached per tweet in `.cache/`) → analytics (`followers.ts`, `engagement.ts`, `people.ts`, `semantic/`) → one columnar `Dataset` (`src/shared/types.ts`) → gzipped into `.cache/` → `pnpm export` writes the public subset to `data/dataset.json` → served by `src/server/plugin.ts` at `/api/dataset` in dev (the export if present, else the live build), or as a static file in production → `src/client/data/model.ts` (typed arrays) → `layouts/*` (pure functions: model → target positions/colors) → `gl/ParticleField.tsx` morphs ~50k instanced particles between layouts on the GPU.

## Invariants

- **Never write to the Birdclaw database.** `src/server/db.ts` opens it read-only (falling back to SQLite `immutable`). Derived output only goes to `.cache/`.
- DM message text never leaves SQLite; only per-person, per-quarter counts are read.
- The export (`src/server/publicExport.ts`) copies an explicit allowlist of `Dataset` fields and audits every string against fingerprints of all DMs. A new `Dataset` field fails to type-check there until you decide whether it is public; never widen the allowlist to anything derived from DM text.
- Bump `PIPELINE_REVISION` in `src/server/cache.ts` whenever server analytics change, or stale caches will be served.
- Layouts must stay pure and index-aligned with `Dataset.tweets` (or `Dataset.people`); the particle field relies on stable indices to morph.
- Follower dates are _reconstructed_ (archive order + snowflake account-creation lower bounds), not observed. Keep UI copy honest about that and about likes being placed at the liked tweet's post time.

## Not in git

- `.cache/` (private, derived from the user's archive), `data/` (the export; deployed, not committed), and `dist/`.
- `media/` holds readme screenshots of the author's own (public) archive, committed with the author's approval. Never commit screenshots or data from anyone else's archive.
- `readme.md` is marketing; technical docs go in `contributing.md`.

## Checks

`pnpm test` (format, oxlint incl. anti-slop rules, `tsc`, vitest on synthetic data — offline, no archive needed) and `pnpm build` (needs `data/dataset.json` from `pnpm export`). Visual changes need a look in the browser: `pnpm dev`, then `?nofx` disables post-processing when debugging rendering.
