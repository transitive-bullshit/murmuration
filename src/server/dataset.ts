import {
  DATASET_VERSION,
  FMT,
  FORMATS,
  TWEET_KINDS,
  type Dataset,
  type TweetColumns
} from '../shared/types'
import { openReadOnly, resolveDbPath, fingerprintDb } from './db'
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
import { buildSemanticMap } from './semantic'
import { LegacyUserIdClock } from './time'

export type ProgressFn = (phase: string, fraction: number) => void

const PLACEHOLDER =
  /^(You’re unable to view this Post|This Post is from a suspended account|This Post (was deleted|is unavailable))/

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
      // X's placeholders for suspended or protected accounts carry no meaning.
      all.map((t) => (PLACEHOLDER.test(t.text) ? '' : t.text)),
      {
        weights,
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
    media: all.map((t) => t.mediaUrl)
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
      timings: { ...timings, ...prefixKeys('semantic.', semantic.timings) }
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

function semanticPhaseLabel(phase: string): string {
  switch (phase) {
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
