# Views and URLs

The site has six views (Constellation, Strata, Growth, Bangers, Anatomy, Orbit). Each has its own URL, the address bar follows the current view, Back and Forward move between views, and `/` reopens the view the visitor used last.

## Sub-features

- `views-tabs` switches views from the `Views` navigation.
- `views-keys` switches views with the number keys 1–6.
- `views-urls` opens a view directly from its URL.
- `views-history` moves between views with Back and Forward.
- `views-last` reopens the last view at `/`, including one opened by URL.
- `views-phone` on phones (under 768px wide or 500px tall): a `Menu` sheet holds the views, search and filters, and insights start as a collapsed pill.

## How to get to it (user POV)

- Click a tab in the `Views` navigation at the top.
- Press 1–6 while focus is not in a text field.
- Open `/constellation`, `/strata`, `/growth`, `/bangers`, `/anatomy` or `/orbit`.
- Use the browser's Back and Forward buttons.
- On a phone, tap `Menu` (top right) and pick a view; tap the `<View> Insights` pill for the panel.

## Driving it with verify.ts

Preconditions: doctor passes.

- **Run it.** `./.agents/skills/verify-murmuration/verify.ts run views`.
- **Tabs.** Clicks `Strata` in the `Views` navigation. The URL becomes `/strata` and the Strata panel appears.
- **Keys.** Presses `6`. The URL becomes `/orbit`.
- **History.** Goes Back. The URL is `/strata` and the Strata panel shows again.
- **URL.** Opens `/growth`. The `Follower inflections` list appears without any click.
- **Last view.** Opens `/`. The URL becomes `/growth`.
- **Phone.** `run phone` drives `views-phone` at 375×812: tabs absent, insights collapsed, `Menu` → Orbit, the pill opens and hides, search in the sheet, a result opens the tweet, and `#root` never scrolls sideways. Proof: `01-strata.jpg` to `04-tweet.jpg`, `02-menu.aria.yml`.
- **All six render.** `pnpm smoke` opens every view by URL and fails on a blank canvas or console errors.
- **Proof.** `steps.md`, `01-constellation.jpg`, `02-orbit-via-key.jpg`, `03-growth-deep-link.jpg` and its `.aria.yml`.

## Gotchas

- Number keys do nothing while the search box has focus.
- `/` reflects the remembered view, so its result depends on what the journey did before; the journey sets it with `/growth` first.
- Between 768 and 1279px wide the tabs sit on a second header row; side panels start below the header via `--header-h`.
- Vercel serves only the six view paths; any other path 404s in production, while `vite preview` serves the app for every path.
