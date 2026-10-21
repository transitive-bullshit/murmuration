# Orbit playback

The Orbit view places followers and following around the user by when they arrived and how close they are. Playing it travels through time so the audience accretes; the side panel lists the closest relationships.

## Sub-features

- `orbit-play` plays and pauses the audience through time.
- `orbit-closest` lists the closest people and opens one.
- `orbit-scrub` moves through time on the timeline.

## How to get to it (user POV)

- Open the Orbit view, then click `Play through time` in the timeline at the bottom, or press Space.
- Click a person under `Closest`.
- Drag on the timeline.

## Driving it with verify.ts

Preconditions: doctor passes.

- **Run it.** `./.agents/skills/verify-murmuration/verify.ts run orbit`.
- **Play.** Clicks `Play through time`. The button becomes `Pause`. Proof: `01-playing.jpg`.
- **Pause.** Clicks `Pause`. The button returns to `Play through time`.
- **Closest.** Clicks the first person under `Closest`. The person panel shows `Closeness over time`. Proof: `02-person.jpg` and `.aria.yml`.

## Gotchas

- Space toggles playback only in Orbit and only when focus is not in a text field.
- Playback re-lays out ~50k particles each step; screenshots mid-play are expected to differ run to run.
- `orbit-scrub` is not in the journey yet.
