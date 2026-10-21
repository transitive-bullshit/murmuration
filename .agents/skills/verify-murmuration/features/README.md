# Murmuration verification map

This directory is the maintained source for verifying murmuration's user-facing behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- `data/dataset.json` is the author's real export; journeys name data from it (a "Jan 2023" surge, "kitten" caption matches). Override with `VERIFY_INFLECTION` and `VERIFY_QUERY` on another archive.
- `dist/` was built from the current sources: `./.agents/skills/verify-murmuration/verify.ts doctor` passes.
- Each journey starts from a fresh browser context with the first-visit controls guide and media previews off.
- Drive only the `vite preview` that `verify.ts` or `pnpm smoke` started, never `pnpm dev`.

## Driving conventions

- Prefer roles and accessible names: the `Views` navigation, buttons by label, search boxes by placeholder, `section` elements filtered by their title.
- Open views by URL (`v.open('growth')`) or as a user would (tab click, number key); never set store state directly.
- Wait for visible text or a URL, not fixed sleeps; short waits are only for camera flights and particle morphs before screenshots.
- The site is read-only: there is nothing to restore after a journey.

## Proof and skip reporting

- Capture the user action and the resulting state: the URL, the panel text, and a screenshot of the result.
- Record the journey name and entry point with each artifact (`steps.md` does this).
- Console errors and failed requests fail the journey (requests to `/_vercel/` are expected locally and ignored).
- Report an unreachable entry point with the step that failed; do not count it as verified through a different path.

## Feature entry contract

Each feature file has an H1 title and a paragraph describing the user-visible behavior, then four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.ts`, `Gotchas`.

## Features

- [Views and URLs](./views-and-urls.md): six views by tab, number key, URL, Back/Forward, the remembered last view, and the phone menu.
- [Search](./search.md): tweet and like search, including image-caption matches, and people search in Orbit.
- [Detail panels](./detail-panels.md): the tweet and person panels opened from search, lists and the scene.
- [Growth inflections](./growth-inflections.md): follower inflections and their most likely causes.
- [Orbit playback](./orbit-playback.md): playing the audience through time.
