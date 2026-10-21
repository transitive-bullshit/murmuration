# Views and URLs

The site has six views (Constellation, Strata, Growth, Bangers, Anatomy, Orbit). Each has its own URL, the address bar follows the current view, Back and Forward move between views, and `/` reopens the view the visitor used last.

## Sub-features

- `views-tabs` switches views from the `Views` navigation.
- `views-keys` switches views with the number keys 1–6.
- `views-urls` opens a view directly from its URL.
- `views-history` moves between views with Back and Forward.
- `views-last` reopens the last view at `/`, including one opened by URL.

## How to get to it (user POV)

- Click a tab in the `Views` navigation at the top.
- Press 1–6 while focus is not in a text field.
- Open `/constellation`, `/strata`, `/growth`, `/bangers`, `/anatomy` or `/orbit`.
- Use the browser's Back and Forward buttons.

## Driving it with verify.ts

Preconditions: doctor passes.

- **Run it.** `./.agents/skills/verify-murmuration/verify.ts run views`.
- **Tabs.** Clicks `Strata` in the `Views` navigation. The URL becomes `/strata` and the Strata panel appears.
- **Keys.** Presses `6`. The URL becomes `/orbit`.
- **History.** Goes Back. The URL is `/strata` and the Strata panel shows again.
- **URL.** Opens `/growth`. The `Follower inflections` list appears without any click.
- **Last view.** Opens `/`. The URL becomes `/growth`.
- **All six render.** `pnpm smoke` opens every view by URL and fails on a blank canvas or console errors.
- **Proof.** `steps.md`, `01-constellation.jpg`, `02-orbit-via-key.jpg`, `03-growth-deep-link.jpg` and its `.aria.yml`.

## Gotchas

- Number keys do nothing while the search box has focus.
- `/` reflects the remembered view, so its result depends on what the journey did before; the journey sets it with `/growth` first.
- Vercel serves only the six view paths; any other path 404s in production, while `vite preview` serves the app for every path.
