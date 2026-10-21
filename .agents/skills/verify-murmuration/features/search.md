# Search

The search box finds tweets and likes by their text and by AI descriptions of their images; a hit that matched only the image says so with an `Image · …` line. In Orbit the same box finds people. Choosing a result flies the camera there and opens its detail panel.

## Sub-features

- `search-text` lists tweets and likes whose text matches every word.
- `search-caption` lists hits matched only by image captions, labeled `Image · …`.
- `search-open` opens a result's detail panel and flies the camera to it.
- `search-people` finds people by name or handle in Orbit.
- `search-keys` moves through results with ↑/↓ and opens one with Enter; Escape clears.

## How to get to it (user POV)

- Click the search box (`Search tweets & likes…`) in the top bar.
- Press `/` or ⌘K.
- In Orbit, the same box reads `Find a person…`.

## Driving it with verify.ts

Preconditions: doctor passes; `VERIFY_QUERY` (default `kitten`) matches at least one tweet by caption in this archive.

- **Run it.** `./.agents/skills/verify-murmuration/verify.ts run search`.
- **Type a query.** Fills `Search tweets & likes…` with the query. The dropdown lists results (`Liked · @handle` or `You · date`).
- **Caption matches.** Counts results carrying an `Image · …` line. At least one is expected for the default query.
- **Open a result.** Clicks a caption match. The detail panel opens with the `Open on X` link and the `Image ·` caption.
- **Close.** Clicks `Close`. The `Open on X` link is gone.
- **Proof.** `01-results.jpg` and `.aria.yml` (the dropdown), `02-detail.jpg` and `.aria.yml` (the panel).

## Gotchas

- Captions exist only for archives built with `OPENAI_API_KEY`; without them `search-caption` can't be shown, and that is a precondition failure, not a pass.
- Results are capped at 7 in the dropdown; the footer gives the total.
- `search-people` and `search-keys` are not in the journey yet; drive them with a new journey before claiming them.
