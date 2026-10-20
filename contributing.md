# Contributing

## Setup

Requirements: Node 24+ (uses the built-in `node:sqlite`), pnpm, and a [Birdclaw](https://birdclaw.sh) archive at `~/.birdclaw/birdclaw.sqlite` (`birdclaw import archive <x-archive.zip>`; `birdclaw sync …` keeps it fresh).

```bash
pnpm install
cp .env.example .env   # optional: add OPENAI_API_KEY
pnpm export            # optional: build data/dataset.json once (see below)
pnpm dev               # https://murmuration.localhost via Portless
```

The dev server serves `data/dataset.json` when it exists. Otherwise it builds from your archive on first load (the page shows progress) and caches the result in `.cache/` until the database changes. Either way, the UI offers a refresh when Birdclaw writes to the archive; with an export, the refresh re-runs the export.

| Variable | Purpose |
| --- | --- |
| `BIRDCLAW_DB` | Path to a different Birdclaw SQLite file (defaults to `~/.birdclaw/birdclaw.sqlite`) |
| `OPENAI_API_KEY` | Optional, in `.env`. Embeds tweets with OpenAI `text-embedding-3-large` and captions their images with `gpt-6-luna`, instead of using a local model (`bge-small-en-v1.5`) with no captions. A first build of ~50k tweets costs roughly $1; later builds only pay for new tweets and images |

Other commands:

```bash
pnpm export           # the full pipeline → data/dataset.json (required by pnpm build)
pnpm export --force   # re-run the analytics even if the archive hasn't changed
pnpm analyze          # build/refresh .cache only; prints inflections
pnpm build && pnpm preview
pnpm test             # format, lint, types, unit tests (offline)
```

`?nofx` in the URL disables post-processing, which helps on weak GPUs and when debugging rendering.

## How it works

| Step | Code | Output |
| --- | --- | --- |
| Read the archive (read-only) | `src/server/db.ts`, `src/server/load.ts` | raw tweets, likes, follows, profiles, DM counts |
| Caption images, embed tweets | `src/server/embed/`, called early in `buildDataset` (`src/server/dataset.ts`) | one vector per tweet from its text plus image captions. Uses OpenAI with `OPENAI_API_KEY`, otherwise local transformers.js, otherwise LSA. Cached per tweet in `.cache/`. Requests fan out 16 at a time (`src/server/fanout.ts`): a failed item is logged, filled in from its nearest tweets, and retried on the next build; the build stops only on a bad key, 10 failures in a row, or a majority failing |
| Classify tweets | `src/server/features.ts` | format (text/image/video/link/quote/thread/reply/repost) + flags |
| Reconstruct follow dates | `src/server/followers.ts` | estimated follow time per follower |
| Score engagement, find inflections | `src/server/engagement.ts` | per-tweet lift/outlier, weekly series, spikes, surges, causes |
| Relationships | `src/server/people.ts` | closeness, quarterly timeline, relationship outliers |
| Topics and 3D map | `src/server/semantic/` | embeddings → PCA (or TF-IDF → LSA without embeddings) → kNN graph → spherical k-means → outlier refinement → c-TF-IDF labels → 3D UMAP |
| Assemble and cache | `src/server/dataset.ts`, `src/server/cache.ts` | `.cache/dataset.json.gz` |
| Export | `scripts/export.ts`, `src/server/exporter.ts`, `src/server/publicExport.ts` | `data/dataset.json`: allowlisted fields, audited for DM text |
| Serve | `src/server/plugin.ts` | dev: `/api/status`, `/api/dataset`, `POST /api/rebuild`. Build: requires the export and ships it as `dist/data/dataset.json` |
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

## Export and deploy

`pnpm export` runs the whole pipeline with each step on its own line: read the archive, describe images, embed tweets, then the analytics. It then writes `data/dataset.json`. It refuses to publish a fallback: if `OPENAI_API_KEY` is set but OpenAI embeddings failed, or the local model failed, it stops (`--allow-fallback` overrides this).

The export contains your tweets, likes, bookmarks, follower and following lists, image captions, and per-person DM message counts. It never contains DM text: the analytics only count DMs, and the audit reads message text locally just to hash it. It also omits the archive's path and your API key. Two layers enforce this:

- `toPublicDataset` copies an explicit allowlist of fields.
- `auditPrivateContent` fingerprints every DM and scans every exported string. A whole DM, or 60 or more consecutive characters of one, aborts the export unless all of the match also appears in your public tweets. Any copied stretch of 98 or more characters is guaranteed to be caught. Shorter shared phrases, such as an article title, are counted and reported.
- DMs under 40 characters ("sounds good!") are too generic to fingerprint, so only the first layer, which never reads DM text, protects them.

`pnpm build` fails without `data/dataset.json` and copies it into `dist/`. The production app is fully static and loads `/data/dataset.json`; `pnpm preview` serves exactly that. `data/` is gitignored, so deploy from your machine with Vercel's prebuilt flow (`vercel.json` holds the settings):

```bash
pnpm export
vercel pull --yes --environment=production
vercel build --prod
vercel deploy --prebuilt --prod
```

`.vercelignore` keeps `.env` and `.cache/` out of uploads in case you deploy from source instead. To keep the site private, turn on Deployment Protection in the Vercel project settings.

## Common tasks

- **Change analytics:** edit `src/server/*`, bump `PIPELINE_REVISION` in `src/server/cache.ts`, then run `pnpm export --force` (or `pnpm analyze --force` if you don't use an export).
- **Add a `Dataset` field:** `src/server/publicExport.ts` won't type-check until you allowlist it there. Only do that if the field is safe to publish.
- **Add a view:** add an id to `VIEWS` in `src/client/store.ts`, a pure layout in `src/client/layouts/`, a camera framing in `src/client/gl/CameraRig.tsx`, an overlay in `src/client/gl/overlays.tsx`, and a panel in `src/client/ui/ViewPanel.tsx`.

## Tests and CI

`test/` holds offline unit tests on synthetic data: snowflake time, follower reconstruction from shuffled blocks, spike/surge detection and attribution, format classification, closeness, and the semantic pipeline. CI (`.github/workflows/test.yml`) runs `pnpm test`; it never needs an archive. It skips `pnpm build`, because production builds need your export.

## Repo map

```
src/shared/types.ts     data contract (Dataset)
src/server/             archive reading + analytics + Vite plugin (Node only)
src/client/data/        dataset loading, typed model, colors, formatting
src/client/layouts/     pure layout functions per view
src/client/gl/          particle shader/field, camera, picking, overlays, effects
src/client/ui/          panels, top bar, timeline, cards
scripts/export.ts       CLI for the full pipeline → data/dataset.json
scripts/analyze.ts      CLI for building the cache
data/                   the export (gitignored)
test/                   vitest
```

## Not in the repo, on purpose

- `.cache/`: derived from your private archive.
- Any archive data or screenshots of it: personal, never committed.
- `dist/`: build output.
