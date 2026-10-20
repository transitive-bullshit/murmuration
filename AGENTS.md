# Project: murmuration

A local, read-only 3D observatory for one person's X/Twitter history, built on their [Birdclaw](https://github.com/steipete/birdclaw) SQLite archive. Vite + React + three.js app with a Vite-plugin API; nothing is deployed. See `contributing.md` for setup and commands.

## Conventions

- use `pnpm`
- use modern TypeScript (ESM only, no CommonJS)
- no semicolons; oxfmt formats (`pnpm fix:format`) and oxlint lints (`pnpm fix:lint`)
- `pnpm test` runs format, lint, types, and unit tests; keep it green
- use `zod` to validate external data
- for local development, use `pnpm dev` and the Portless URL it prints

## Mental model

`~/.birdclaw/birdclaw.sqlite` (read-only) → `src/server/load.ts` (SQL → raw records) → analytics (`followers.ts`, `engagement.ts`, `people.ts`, `semantic/`) → one columnar `Dataset` (`src/shared/types.ts`) → gzipped into `.cache/` and served by `src/server/plugin.ts` at `/api/dataset` → `src/client/data/model.ts` (typed arrays) → `layouts/*` (pure functions: model → target positions/colors) → `gl/ParticleField.tsx` morphs ~50k instanced particles between layouts on the GPU.

## Invariants

- **Never write to the Birdclaw database.** `src/server/db.ts` opens it read-only (falling back to SQLite `immutable`). Derived output only goes to `.cache/`.
- DM message text never leaves SQLite; only per-person, per-quarter counts are read.
- Bump `PIPELINE_REVISION` in `src/server/cache.ts` whenever server analytics change, or stale caches will be served.
- Layouts must stay pure and index-aligned with `Dataset.tweets` (or `Dataset.people`); the particle field relies on stable indices to morph.
- Follower dates are _reconstructed_ (archive order + snowflake account-creation lower bounds), not observed. Keep UI copy honest about that and about likes being placed at the liked tweet's post time.

## Not in git

- `.cache/` (private, derived from the user's archive) and `dist/`.
- `media/` holds readme screenshots of the author's own (public) archive, committed with the author's approval. Never commit screenshots or data from anyone else's archive.
- `readme.md` is marketing; technical docs go in `contributing.md`.

## Checks

`pnpm test` (format, oxlint incl. anti-slop rules, `tsc`, vitest on synthetic data — offline, no archive needed) and `pnpm build`. Visual changes need a look in the browser: `pnpm dev`, then `?nofx` disables post-processing when debugging rendering.
