---
name: verify-murmuration
description: Drive the built murmuration site headlessly in Chromium (the six WebGL views, search, tweet and person panels, Growth inflections, Orbit playback) and capture screenshots, ARIA snapshots and console errors as evidence. Use to prove a UI, layout or rendering change works the way a user sees it before calling it done, or when a view looks blank or broken.
---

# Verify murmuration

The surface is a static WebGL web app (`dist/`), built from the real export at `data/dataset.json`. The harness serves that build itself and drives it with Playwright; it never touches the user's `pnpm dev`.

## Launch

1. The real export must exist: `data/dataset.json`. Without it, run `pnpm export --plan`, then `pnpm export` (it can make paid OpenAI calls; see AGENTS.md "Paid pipeline").
2. Build after any source change: `pnpm build` (about 1 s).
3. `verify.ts run` starts its own `vite preview` of `dist/` on a free `127.0.0.1` port and prints its pid. Ready means the page returns 200 and each journey then waits for the view's side panel and the ~2.6 s particle morph.

Never drive the user's `pnpm dev` (Portless) server: editing server files restarts it, it can start paid builds, and the user may be watching it.

## Doctor

```bash
./.agents/skills/verify-murmuration/verify.ts doctor
```

Read-only. Checks Node 24+, the export, that `dist/` is newer than every source file (otherwise rebuild), that Playwright's Chromium is installed, and reports the git commit. Run it first, and whenever a result looks wrong.

## Drive

- **Baseline, every view:** `pnpm smoke` (builds first). Fails on console errors, failed requests, a missing panel, or a blank canvas (under 0.2% of pixels lit, which is what a NaN in a shader produces).
- **Journeys:** `./.agents/skills/verify-murmuration/verify.ts run [journey…]` (no names runs all; `list` shows them). Each runs in a fresh Chromium context at 1440×900 with the first-visit guide and media previews (images from X) turned off.
- **New behavior:** add `journeys/<name>.ts` exporting `default async (v: Verify) => { … }` and run it. Use `v.open(view)`, `v.step(text)`, `v.check(ok, message)`, `v.shot(name)`, `v.aria(name)`, and `v.page` (Playwright). Drive like a user (clicks, keys, URLs), never by calling store setters.
- **Handles:** the `Views` navigation and its buttons (`Constellation` … `Orbit`); views by URL (`/strata`); search boxes by placeholder (`Search tweets & likes…`, `Find a person…` in Orbit); `section` elements filtered by their title (`Topics`, `Follower inflections`, `Most likely causes`, `Closest`); buttons `Close`, `Play through time`/`Pause`; link `Open on X`.
- **What to verify:** [features/README.md](features/README.md) maps each feature to its entry points, journey and proof.

## Evidence

Each run writes `.cache/verify/<timestamp>/<journey>/`: `steps.md` (PASS or FAIL, every step, every failure), JPEG screenshots and `*.aria.yml` snapshots. `--out <dir>` writes elsewhere. `pnpm smoke` writes `.cache/smoke/<view>.jpg`. Cleanup never deletes evidence.

Proof means the user action and the resulting state: the URL after navigation, the panel text after a click, the screenshot of the result. Console errors and failed requests fail a journey; requests to `/_vercel/` are ignored because Web Analytics only exists on Vercel.

## Cleanup

`verify.ts` and `pnpm smoke` stop the `vite preview` they started and close Chromium, even when a journey fails. If a run is interrupted, kill the pid it printed, never by process name, and never `pnpm dev`.

## Helpers

- `verify.ts`: `doctor`, `list`, `run`.
- `journeys/*.ts`: `views`, `search`, `growth`, `orbit`, `phone` (resizes to 375×812 itself).
- `scripts/smoke.ts` (`pnpm smoke`) and `scripts/lib/browser.ts`: the shared Playwright plumbing.
- `scripts/shots.ts` (`pnpm shots`) regenerates the committed readme screenshots and `public/og.jpg`. Run it only when those images should change.
