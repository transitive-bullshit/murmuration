# Detail panels

Selecting a tweet or a person opens a panel on the right. A tweet panel shows the text, image and its AI caption, metrics, topic, an `Open on X` link and nearby tweets. A person panel shows the relationship, `Closeness over time` and their tweets the user liked.

## Sub-features

- `detail-tweet` shows a tweet's text, metrics, topic, caption and `Open on X`.
- `detail-person` shows a person's closeness over time and liked tweets.
- `detail-close` closes the panel with `Close` or Escape.

## How to get to it (user POV)

- Choose a search result (see [Search](./search.md)).
- Click a particle in the scene, or a tweet in a view's side list (e.g. Bangers' top 50).
- In Orbit, click a person under `Closest`, `Rising` or `Drifted apart`.

## Driving it with verify.ts

Preconditions: doctor passes.

- **Tweet panel.** `verify.ts run search` opens a tweet from search; the panel shows `Open on X`, and for a caption match the `Image ·` line. Proof: `02-detail.jpg` and `.aria.yml`.
- **Person panel.** `verify.ts run orbit` clicks the first person under `Closest`; the panel shows `Closeness over time`. Proof: `02-person.jpg` and `.aria.yml`.
- **Close.** The search journey clicks `Close` and checks that `Open on X` is gone.

## Gotchas

- The panel slides in over ~300 ms and the camera flies for ~2 s; wait for panel text, then pause briefly before a screenshot.
- Clicking a particle needs it under the cursor after the camera settles; prefer lists and search, which are deterministic.
- Media previews are off in journeys, so the panel shows the caption but not the image itself.
