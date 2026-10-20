import path from 'node:path'

import {
  DATASET_VERSION,
  FMT,
  FORMATS,
  TWEET_KINDS,
  type Dataset,
  type TweetColumns
} from '../shared/types'
import { openReadOnly, resolveDbPath, fingerprintDb } from './db'
import type { FanoutProgress } from './fanout'
import {
  captionTweetImages,
  embedTexts,
  embeddingInput,
  localEmbedder,
  openaiEmbedder,
  truncateVectors,
  type EmbedderSpec,
  type Embeddings
} from './embed'
import {
  buildWeeklySeries,
  detectInflections,
  scoreTweets,
  type ScoreGroup
} from './engagement'
import { tweetFeatures, type TweetFeatures } from './features'
import { reconstructFollowTimes } from './followers'
import { loadArchive, type RawTweet } from './load'
import { buildPeople, type PersonInteraction } from './people'
import { buildSemanticMap, captionTerms } from './semantic'
import { LegacyUserIdClock } from './time'

export type ProgressFn = (phase: string, fraction: number) => void

const PLACEHOLDER =
  /^(You’re unable to view this Post|This Post is from a suspended account|This Post (was deleted|is unavailable))/

const OPENAI_MAP_DIMS = 256

/** Rounds for compact JSON; non-finite values become 0 (JSON would emit null). */
const round = (v: number, digits: number) => {
  if (!Number.isFinite(v)) return 0
  const f = 10 ** digits
  return Math.round(v * f) / f
}

export async function buildDataset(
  onProgress: ProgressFn = () => {}
): Promise<Dataset> {
  const timings: Record<string, number> = {}
  const time = async <T>(
    label: string,
    fn: () => T | Promise<T>
  ): Promise<T> => {
    const t0 = performance.now()
    const result = await fn()
    timings[label] = Math.round(performance.now() - t0)
    return result
  }

  const dbPath = resolveDbPath()
  const fingerprint = fingerprintDb(dbPath)
  onProgress('Reading your Birdclaw archive', 0)
  const archive = await time('load', () => {
    const db = openReadOnly(dbPath)
    try {
      return loadArchive(db)
    } finally {
      db.close()
    }
  })
  const { account } = archive
  onProgress('Reading your Birdclaw archive', 1)

  // Tweet features ---------------------------------------------------------
  const selfThreadParents = new Set<string>()
  for (const t of archive.mine) {
    if (t.replyToId && t.replyToProfileId === account.profileId)
      selfThreadParents.add(t.replyToId)
  }
  const all: RawTweet[] = [
    ...archive.mine,
    ...archive.likes,
    ...archive.bookmarks
  ].sort((a, b) => a.t - b.t)
  const features: TweetFeatures[] = all.map((t) =>
    tweetFeatures(t, { selfProfileId: account.profileId, selfThreadParents })
  )

  // Image captions & embeddings ---------------------------------------------
  // X's placeholders for suspended or protected accounts carry no meaning.
  const texts = all.map((t) => (PLACEHOLDER.test(t.text) ? '' : t.text))
  const cacheDir = path.join(process.cwd(), '.cache')
  const apiKey = process.env.OPENAI_API_KEY || undefined
  const warnings: string[] = []
  const step = { cacheDir, apiKey, onProgress, warnings }
  const captions = await time('captions', () => describeImages(all, step))
  const embedding = await time('embed', () =>
    embedTweets(all, texts, captions, step)
  )

  // Follower history ---------------------------------------------------------
  onProgress('Reconstructing follower history', 0)
  const clockSamples = [...archive.profiles.values()]
    .filter((p) => p.createdAt && p.externalId)
    .map((p) => ({ id: p.externalId, createdAt: p.createdAt! }))
  clockSamples.push({
    id: account.externalUserId,
    createdAt: account.createdAt
  })
  const clock = new LegacyUserIdClock(clockSamples)
  // Capped live syncs are recorded as `incomplete` and must never stand in
  // for the full list; use the latest complete (or archive) snapshot.
  const lastSnapshot = (direction: 'followers' | 'following') =>
    archive.followSnapshots
      .filter((s) => s.direction === direction && s.status !== 'incomplete')
      .at(-1)
  const followerSnap = lastSnapshot('followers')
  const followingSnap = lastSnapshot('following')
  const now = Math.floor(Date.now() / 1000)
  const empty = {
    followedAt: new Map<string, number>(),
    times: new Float64Array(),
    blocks: 0,
    records: 0,
    method: ''
  }
  const followers = await time('followers', () =>
    followerSnap
      ? reconstructFollowTimes(followerSnap, clock, {
          floor: account.createdAt,
          ceiling: followerSnap.completedAt
        })
      : empty
  )
  const following = followingSnap
    ? reconstructFollowTimes(followingSnap, clock, {
        floor: account.createdAt,
        ceiling: followingSnap.completedAt
      })
    : empty
  onProgress('Reconstructing follower history', 1)

  // Engagement scores -------------------------------------------------------
  const groupOf = (i: number): ScoreGroup => {
    const t = all[i]!
    const f = features[i]!
    if (t.kind !== 'mine' || f.format === 'retweet') return 'skip'
    if (f.format === 'reply') return 'reply'
    if (f.flags & FMT.threadPart) return 'skip'
    return 'original'
  }
  const scored = all.map((t, i) => ({
    t: t.t,
    likes: t.likes,
    rts: t.rts,
    group: groupOf(i)
  }))
  const { lift, outlier } = await time('scores', () => scoreTweets(scored))

  // Semantic map -------------------------------------------------------------
  const weights = new Float32Array(
    all.map((t) => (t.kind === 'mine' ? 1 : 0.6))
  )
  const semantic = await time('semantic', () =>
    buildSemanticMap(
      // Labels come from the words of the tweet and its image captions
      // (minus the captions' visual filler: "sits", "beneath", colors).
      texts.map((text, i) =>
        [text, ...captions[i]!.map(captionTerms)].join('\n')
      ),
      {
        weights,
        // text-embedding-3 is Matryoshka-trained: a short prefix keeps the
        // neighborhood structure at a fraction of the clustering cost.
        ...(embedding && {
          vectors:
            embedding.provider === 'openai'
              ? truncateVectors(
                  embedding.vectors,
                  embedding.dim,
                  OPENAI_MAP_DIMS
                )
              : embedding.vectors,
          dim:
            embedding.provider === 'openai'
              ? Math.min(OPENAI_MAP_DIMS, embedding.dim)
              : embedding.dim
        }),
        onProgress: (phase, fraction) =>
          onProgress(semanticPhaseLabel(phase), fraction)
      }
    )
  )

  // People -------------------------------------------------------------------
  onProgress('Mapping your relationships', 0)
  const handleToProfile = new Map<string, string>()
  for (const p of archive.profiles.values())
    if (p.handle) handleToProfile.set(p.handle.toLowerCase(), p.id)
  const interactions: PersonInteraction[] = []
  all.forEach((t, i) => {
    const f = features[i]!
    if (t.kind === 'mine') {
      if (f.format === 'retweet') {
        const pid =
          f.retweetedHandle &&
          handleToProfile.get(f.retweetedHandle.toLowerCase())
        if (pid) interactions.push({ profileId: pid, t: t.t, kind: 'share' })
        return
      }
      if (t.replyToProfileId && !(f.flags & FMT.selfReply)) {
        interactions.push({
          profileId: t.replyToProfileId,
          t: t.t,
          kind: 'reply'
        })
      }
      for (const m of t.mentions) {
        if (m !== t.replyToProfileId)
          interactions.push({ profileId: m, t: t.t, kind: 'mention' })
      }
      const quoted =
        f.quotedHandle && handleToProfile.get(f.quotedHandle.toLowerCase())
      if (quoted)
        interactions.push({ profileId: quoted, t: t.t, kind: 'share' })
    } else if (t.kind === 'like' && t.authorProfileId) {
      interactions.push({ profileId: t.authorProfileId, t: t.t, kind: 'like' })
    }
  })
  for (const inbound of archive.inbound) {
    interactions.push({
      profileId: inbound.authorProfileId,
      t: inbound.t,
      kind: 'inbound'
    })
  }

  // The timeline ends at the newest thing we know about: any tweet (yours or
  // liked), the latest follower count, or the latest follow snapshot.
  const lastTweet = all.reduce((m, t) => Math.max(m, t.t), 0)
  const lastAnchor = archive.followerAnchors.at(-1)?.t ?? 0
  const end = Math.min(
    now,
    Math.max(
      lastTweet,
      lastAnchor,
      followerSnap?.completedAt ?? 0,
      followingSnap?.completedAt ?? 0
    )
  )
  const { people, timeline, indexOf } = await time('people', () =>
    buildPeople({
      archive,
      interactions,
      followedAt: followers.followedAt,
      followingAt: following.followedAt,
      end
    })
  )
  onProgress('Mapping your relationships', 1)

  // Series & inflections -------------------------------------------------
  onProgress('Finding inflection points', 0)
  const series = buildWeeklySeries({
    mine: all
      .map((t, i) => ({
        ...scored[i]!,
        isThreadPart: !!(features[i]!.flags & FMT.threadPart)
      }))
      .filter((_, i) => all[i]!.kind === 'mine'),
    likeTimes: archive.likes.map((t) => t.t),
    followerTimes: followers.times,
    followingTimes: following.times,
    snapshotTime: followerSnap?.completedAt ?? end,
    anchors: archive.followerAnchors,
    start: account.createdAt,
    end
  })

  const inflections = detectInflections(series, {
    tweets: all.map((t, i) => ({
      index: i,
      t: t.t,
      likes: t.likes,
      rts: t.rts,
      lift: lift[i]!,
      outlier: outlier[i]!,
      isReply: scored[i]!.group === 'reply',
      eligible: scored[i]!.group !== 'skip'
    })),
    followers: [...followers.followedAt.entries()].flatMap(([pid, at]) => {
      const index = indexOf.get(pid)
      if (index === undefined) return []
      return [{ index, followedAt: at, followers: people.followers[index]! }]
    })
  })
  onProgress('Finding inflection points', 1)

  // Assemble -----------------------------------------------------------------
  const tweets: TweetColumns = {
    n: all.length,
    id: all.map((t) => t.id),
    kind: all.map((t) => TWEET_KINDS.indexOf(t.kind)),
    t: all.map((t) => t.t),
    likes: all.map((t) => t.likes),
    rts: all.map((t) => t.rts),
    replies: all.map((t) => t.replies),
    quotes: all.map((t) => t.quotes),
    views: all.map((t) => t.views),
    flags: features.map((f) => f.flags),
    format: features.map((f) => FORMATS.indexOf(f.format)),
    len: features.map((f) => f.len),
    author: all.map((t) =>
      t.authorProfileId ? (indexOf.get(t.authorProfileId) ?? -1) : -1
    ),
    cluster: Array.from(semantic.cluster),
    sx: Array.from({ length: all.length }, (_, i) =>
      round(semantic.coords[i * 3]!, 4)
    ),
    sy: Array.from({ length: all.length }, (_, i) =>
      round(semantic.coords[i * 3 + 1]!, 4)
    ),
    sz: Array.from({ length: all.length }, (_, i) =>
      round(semantic.coords[i * 3 + 2]!, 4)
    ),
    outlier: Array.from(outlier, (v) => round(v, 2)),
    lift: Array.from(lift, (v) => round(v, 2)),
    text: all.map((t) => t.text),
    media: all.map((t) => t.mediaUrl),
    caption: captions.map((c) => c.join('\n'))
  }

  return {
    meta: {
      version: DATASET_VERSION,
      generatedAt: new Date().toISOString(),
      dbPath,
      dbModifiedAt: new Date(fingerprint.mtimeMs).toISOString(),
      account: {
        handle: account.handle,
        name: account.name,
        profileId: account.profileId,
        createdAt: account.createdAt
      },
      counts: {
        mine: archive.mine.length,
        likes: archive.likes.length,
        bookmarks: archive.bookmarks.length,
        followers: archive.currentFollowers.size,
        following: archive.currentFollowing.size,
        dms: archive.dmTotal
      },
      range: { start: account.createdAt, end },
      timings: { ...timings, ...prefixKeys('semantic.', semantic.timings) },
      embedding: embedding
        ? {
            provider: embedding.provider === 'openai' ? 'openai' : 'local',
            model: embedding.model,
            dims: embedding.dim,
            captions: captions.filter((c) => c.length > 0).length,
            missing: embedding.missing,
            imputed: semantic.imputed
          }
        : {
            provider: 'lsa',
            model: 'tf-idf + truncated svd',
            dims: 96,
            captions: 0,
            missing: 0,
            imputed: 0
          },
      warnings
    },
    tweets,
    clusters: semantic.clusters,
    series,
    inflections,
    people,
    peopleTimeline: timeline,
    followerModel: {
      method: followers.method,
      total: followers.times.length,
      following: following.times.length,
      blocks: followers.blocks,
      anchors: archive.followerAnchors.map((a) => ({
        t: a.t,
        followers: a.followers
      }))
    }
  }
}

const errorMessage = (err: unknown, secret?: string) => {
  const message = err instanceof Error ? err.message : String(err)
  return secret ? message.replaceAll(secret, '***') : message
}

/** "Embedding tweets (1,200 of 44,739 · 3 skipped)" */
const countPhase = (phase: string, { done, failed, total }: FanoutProgress) =>
  `${phase} (${done.toLocaleString()} of ${total.toLocaleString()}${failed ? ` · ${failed.toLocaleString()} skipped` : ''})`

interface StepOptions {
  cacheDir: string
  apiKey?: string
  onProgress: ProgressFn
  /** user-facing notes collected into meta.warnings */
  warnings: string[]
}

/** Captions for each tweet's first images (OpenAI only), cached per media URL. */
async function describeImages(
  all: RawTweet[],
  options: StepOptions
): Promise<string[][]> {
  const none = all.map(() => [])
  if (!options.apiKey) return none
  const media = all.map((t) => t.mediaUrls ?? (t.mediaUrl ? [t.mediaUrl] : []))
  const log = (line: string) =>
    console.warn(line.replaceAll(options.apiKey!, '***'))
  options.onProgress('Describing images', 0)
  try {
    const result = await captionTweetImages(media, {
      cacheDir: options.cacheDir,
      apiKey: options.apiKey,
      log,
      onProgress: (p) =>
        options.onProgress(
          countPhase('Describing images', p),
          p.done / Math.max(1, p.total)
        )
    })
    if (result.warning) options.warnings.push(result.warning)
    if (result.error) {
      log(
        `[murmuration] image captions stopped early: ${errorMessage(result.error, options.apiKey)}`
      )
      options.warnings.push(
        'Describing images stopped early; the rest will be described on the next rebuild.'
      )
    }
    return result.captions
  } catch (err) {
    log(
      `[murmuration] image captions unavailable: ${errorMessage(err, options.apiKey)}`
    )
    options.warnings.push(
      'Images could not be described this time; topics use tweet text only.'
    )
    return none
  } finally {
    options.onProgress('Describing images', 1)
  }
}

/**
 * Embeds tweet text plus image captions with the best available provider:
 * OpenAI (when a key is set), then local transformers.js. Returns undefined
 * when neither works, so the semantic map falls back to bag-of-words LSA.
 */
async function embedTweets(
  all: RawTweet[],
  texts: string[],
  captions: string[][],
  options: StepOptions
): Promise<Embeddings | undefined> {
  const inputs: string[] = []
  for (const [i, text] of texts.entries()) {
    inputs.push(embeddingInput(text, captions[i]))
    // Regex-heavy cleanup: let the dev server breathe.
    if (i % 2000 === 1999) await new Promise((resolve) => setImmediate(resolve))
  }
  const providers: EmbedderSpec[] = [
    ...(options.apiKey ? [openaiEmbedder({ apiKey: options.apiKey })] : []),
    localEmbedder(options.cacheDir)
  ]
  const log = (line: string) =>
    console.warn(options.apiKey ? line.replaceAll(options.apiKey, '***') : line)
  for (const embedder of providers) {
    options.onProgress('Embedding tweets', 0)
    try {
      const result = await embedTexts(
        all.map((t) => t.id),
        inputs,
        {
          cacheDir: options.cacheDir,
          embedder,
          log,
          onProgress: (p) =>
            options.onProgress(
              countPhase('Embedding tweets', p),
              p.done / Math.max(1, p.total)
            )
        }
      )
      if (result.warning) options.warnings.push(result.warning)
      return result
    } catch (err) {
      log(
        `[murmuration] ${embedder.provider} embeddings failed, trying the next option: ${errorMessage(err, options.apiKey)}`
      )
      options.warnings.push(
        embedder.provider === 'openai'
          ? 'OpenAI embeddings failed this time; topics use the local model instead.'
          : 'Local embeddings failed; topics fall back to word statistics.'
      )
    } finally {
      options.onProgress('Embedding tweets', 1)
    }
  }
  return undefined
}

function semanticPhaseLabel(phase: string): string {
  switch (phase) {
    case 'reducing':
      return 'Condensing embeddings'
    case 'neighbors':
      return 'Connecting similar tweets'
    case 'tokenizing':
      return 'Reading every tweet'
    case 'tf-idf':
      return 'Weighing words'
    case 'svd':
      return 'Finding latent topics'
    case 'clustering':
      return 'Clustering topics'
    case 'labeling':
      return 'Naming clusters'
    case 'projecting':
      return 'Folding meaning into 3D'
    default:
      return phase
  }
}

const prefixKeys = (prefix: string, obj: Record<string, number>) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [prefix + k, v]))
