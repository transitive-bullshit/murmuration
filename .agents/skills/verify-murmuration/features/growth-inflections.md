# Growth inflections

The Growth view plots reconstructed followers above every tweet's engagement. Its side panel lists follower inflections and engagement spikes; choosing one focuses the camera on it and lists the most likely causes, or flags that the boost came from somewhere else.

## Sub-features

- `growth-list` lists follower inflections (spikes and surges) and engagement spikes.
- `growth-focus` focuses an inflection and shows `Most likely causes`.
- `growth-back` returns to the list with Escape.

## How to get to it (user POV)

- Open the Growth view, then choose an entry under `Follower inflections` or `Engagement spikes`.
- Click a labeled beacon on the follower curve.

## Driving it with verify.ts

Preconditions: doctor passes; the inflection named by `VERIFY_INFLECTION` (default `Jan 2023`) exists in this archive.

- **Run it.** `./.agents/skills/verify-murmuration/verify.ts run growth`.
- **List.** The `Follower inflections` section contains a button with the label. Proof: `01-growth.jpg`.
- **Focus.** Clicks it. The panel shows `Most likely causes` and the camera flies to the inflection. Proof: `02-inflection.jpg` and `.aria.yml`.
- **Back.** Presses Escape. `Most likely causes` disappears.

## Gotchas

- Labels look like `↗ Jan 2023 · +3.8K` (surges carry ↗); match on the month and year.
- Inflections are recomputed from the archive on each export; a different archive needs a different `VERIFY_INFLECTION`.
- Clicking beacons in the scene is not in the journey; the list is the reliable entry point.
