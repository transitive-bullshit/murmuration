# Contributing

## Setup

Requirements: Node 24+ (uses the built-in `node:sqlite`), pnpm, and a [Birdclaw](https://birdclaw.sh) archive at `~/.birdclaw/birdclaw.sqlite` (`birdclaw import archive <x-archive.zip>`; `birdclaw sync …` keeps it fresh).

```bash
pnpm install
pnpm dev            # https://murmuration.localhost via Portless
```

The first load reads the whole archive and builds the analytics (about a minute for ~50k tweets; the page shows progress). The result is cached in `.cache/` and reused until the database changes. The UI offers a refresh when Birdclaw writes to it.

| Variable | Purpose |
| --- | --- |
| `BIRDCLAW_DB` | Path to a different Birdclaw SQLite file (defaults to `~/.birdclaw/birdclaw.sqlite`) |

Other commands:

```bash
pnpm analyze          # build/refresh .cache without starting the app; prints inflections
pnpm analyze --force  # rebuild even if the archive hasn't changed
pnpm build && pnpm preview
pnpm test             # format, lint, types, unit tests (offline)
```

`?nofx` in the URL disables post-processing, which helps on weak GPUs and when debugging rendering.

## How it works

| Step | Code | Output |
| --- | --- | --- |
| Read the archive (read-only) | `src/server/db.ts`, `src/server/load.ts` | raw tweets, likes, follows, profiles, DM counts |
| Classify tweets | `src/server/features.ts` | format (text/image/video/link/quote/thread/reply/repost) + flags |
| Reconstruct follow dates | `src/server/followers.ts` | estimated follow time per follower |
| Score engagement, find inflections | `src/server/engagement.ts` | per-tweet lift/outlier, weekly series, spikes, surges, causes |
| Relationships | `src/server/people.ts` | closeness, quarterly timeline, relationship outliers |
| Topics and 3D map | `src/server/semantic/` | TF-IDF → LSA → spherical k-means → UMAP, cluster labels |
| Assemble and cache | `src/server/dataset.ts`, `src/server/cache.ts` | `.cache/dataset.json.gz` |
| Serve | `src/server/plugin.ts` | `/api/status`, `/api/dataset`, `POST /api/rebuild` |
| Views | `src/client/layouts/*`, `src/client/gl/*` | particle layouts + overlays per view |

### Follower history

X exports no follow timestamps. The archive lists followers newest-first, but in blocks concatenated out of order. `followers.ts` restores a global order by sorting on a local time key, then takes the running maximum of account-creation times. That is a hard lower bound on each follow, since snowflake user ids encode the creation time and older ids are interpolated from known profiles. It then interpolates between "record" accounts (brand-new accounts that followed immediately). After the archive snapshot, the series uses Birdclaw's exact observed follower counts.

### Inflections and causes

`engagement.ts` finds two kinds of events in weekly follower gains and engagement:

- **Spikes:** robust z-score against a ±13-week local median.
- **Surges:** the next 8 weeks gain far more per week than the previous 26.

Candidate causes are your tweets near the event, scored by engagement, timing, and surprise. If your tweets can't plausibly explain the jump at your usual followers-per-engagement rate, part of the effect is attributed to an off-platform cause.

### Performance: lift and hit rate

Each of your tweets is compared with your rolling median for the same kind of tweet (originals vs. replies, ±60 days), so early eras with fewer followers aren't penalized. A tweet with at least 2× that median is a hit. Anatomy groups tweets by format, topic, weekday, hour, or length and ranks the groups by hit rate, since medians collapse toward 1× for large mixed groups. Groupings other than format use original tweets only.

## Common tasks

- **Change analytics:** edit `src/server/*`, bump `PIPELINE_REVISION` in `src/server/cache.ts`, run `pnpm analyze --force`.
- **Add a view:** add an id to `VIEWS` in `src/client/store.ts`, a pure layout in `src/client/layouts/`, a camera framing in `src/client/gl/CameraRig.tsx`, an overlay in `src/client/gl/overlays.tsx`, and a panel in `src/client/ui/ViewPanel.tsx`.

## Tests and CI

`test/` holds offline unit tests on synthetic data: snowflake time, follower reconstruction from shuffled blocks, spike/surge detection and attribution, format classification, closeness, and the semantic pipeline. CI (`.github/workflows/test.yml`) runs `pnpm test` and `pnpm build`; it never needs an archive.

## Repo map

```
src/shared/types.ts     data contract (Dataset)
src/server/             archive reading + analytics + Vite plugin (Node only)
src/client/data/        dataset loading, typed model, colors, formatting
src/client/layouts/     pure layout functions per view
src/client/gl/          particle shader/field, camera, picking, overlays, effects
src/client/ui/          panels, top bar, timeline, cards
scripts/analyze.ts      CLI for building the cache
test/                   vitest
```

## Not in the repo, on purpose

- `.cache/`: derived from your private archive.
- Any archive data or screenshots of it: personal, never committed.
- `dist/`: build output.
