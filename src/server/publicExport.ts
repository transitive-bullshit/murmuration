import path from 'node:path'

import type {
  Dataset,
  DatasetMeta,
  FollowerModelInfo,
  Inflection,
  PeopleColumns,
  PeopleTimeline,
  SemanticCluster,
  TweetColumns,
  WeeklySeries
} from '../shared/types'

// The publishable snapshot of a dataset: everything the app needs to run as
// static files, with private data removed and the result audited for DM
// text. DM *metadata* (message counts per person) stays; DM *content* is
// never read by the analytics. The audit reads it locally, keeps only
// hashes, and checks that none of it reached the export.

/** Bump when the export file's shape changes. */
export const EXPORT_FORMAT = 1

export interface DmAudit {
  /** DMs in the archive */
  messages: number
  /** DMs long enough to fingerprint reliably (shorter ones can't be told apart from ordinary phrases) */
  fingerprinted: number
  /** DM fingerprints that also occur in public tweets (a passage made only of these isn't private) */
  publicOverlap: number
  /** exported strings sharing only a short phrase with some DM (below LEAK_RUN; not a leak) */
  sharedPhrases: number
  /** exported strings and characters scanned */
  strings: number
  chars: number
  /** exported fields that contain DM text or another forbidden value; must be empty */
  leaks: string[]
}

export interface ExportManifest {
  format: number
  exportedAt: string
  /** analytics pipeline revision that produced the data */
  revision: number
  /** the archive it was built from (size and mtime only, no path) */
  source: { size: number; mtimeMs: number }
  audit: DmAudit
}

export type PublicExport = Dataset & { export: ExportManifest }

// Allowlist --------------------------------------------------------------------

/** Every key of T, each explicitly published (true) or dropped (false). */
type Allow<T> = { [K in keyof Required<T>]: boolean }

/**
 * Copies exactly the allowlisted keys. Adding a field to the Dataset types
 * fails to type-check here until someone decides it's public, and a field
 * that appears at runtime without being allowlisted aborts the export.
 */
function allow<T extends object>(label: string, src: T, keys: Allow<T>): T {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(src)) {
    if (!(key in keys))
      throw new Error(
        `${label}.${key} is not in the public export allowlist (src/server/publicExport.ts)`
      )
    if (keys[key as keyof T]) out[key] = (src as Record<string, unknown>)[key]
  }
  return out as T
}

const TWEETS: Allow<TweetColumns> = {
  n: true,
  id: true,
  kind: true,
  t: true,
  likes: true,
  rts: true,
  replies: true,
  quotes: true,
  views: true,
  flags: true,
  format: true,
  len: true,
  author: true,
  cluster: true,
  sx: true,
  sy: true,
  sz: true,
  outlier: true,
  lift: true,
  text: true,
  media: true,
  caption: true
}

const PEOPLE: Allow<PeopleColumns> = {
  n: true,
  id: true,
  handle: true,
  name: true,
  avatar: true,
  followers: true,
  verified: true,
  rel: true,
  followedAt: true,
  followingAt: true,
  outReplies: true,
  outMentions: true,
  outLikes: true,
  outShares: true,
  inMentions: true,
  // DM counts are metadata; message text never enters the dataset.
  dmIn: true,
  dmOut: true,
  closeness: true,
  outlier: true,
  outlierReason: true
}

const SERIES: Allow<WeeklySeries> = {
  t: true,
  posts: true,
  replies: true,
  likesGiven: true,
  likesReceived: true,
  rtsReceived: true,
  medianLikes: true,
  meanEngagement: true,
  followers: true,
  followerGain: true,
  following: true
}

const CLUSTER: Allow<SemanticCluster> = {
  id: true,
  label: true,
  terms: true,
  size: true,
  centroid: true
}

const INFLECTION: Allow<Inflection> = {
  id: true,
  metric: true,
  kind: true,
  t: true,
  t0: true,
  t1: true,
  gain: true,
  baseline: true,
  z: true,
  ratio: true,
  summary: true,
  causes: true,
  notableFollowers: true
}

const META: Allow<DatasetMeta> = {
  version: true,
  generatedAt: true,
  dbPath: true,
  dbModifiedAt: true,
  account: true,
  counts: true,
  range: true,
  timings: true,
  embedding: true,
  // Build diagnostics for you ("rebuild to finish captions"); viewers of a
  // published snapshot can't act on them. `pnpm export` prints them instead.
  warnings: false,
  // Only dev builds hold paid work back; the export refuses to publish one.
  held: false
}

const DATASET: Allow<Dataset> = {
  meta: true,
  tweets: true,
  clusters: true,
  series: true,
  inflections: true,
  people: true,
  peopleTimeline: true,
  followerModel: true
}

/** The dataset minus anything that shouldn't leave this machine. */
export function toPublicDataset(ds: Dataset): Dataset {
  allow('dataset', ds, DATASET)
  const meta = allow('meta', ds.meta, META)
  return {
    meta: {
      ...meta,
      // Where the archive lives on this machine is nobody's business.
      dbPath: path.basename(meta.dbPath),
      account: allow('meta.account', meta.account, {
        handle: true,
        name: true,
        profileId: true,
        createdAt: true
      }),
      counts: allow('meta.counts', meta.counts, {
        mine: true,
        likes: true,
        bookmarks: true,
        followers: true,
        following: true,
        dms: true
      }),
      range: allow('meta.range', meta.range, { start: true, end: true }),
      timings: Object.fromEntries(
        Object.entries(meta.timings).filter(([, v]) => typeof v === 'number')
      ),
      embedding: allow('meta.embedding', meta.embedding, {
        provider: true,
        model: true,
        dims: true,
        captions: true,
        missing: true,
        imputed: true
      })
    },
    tweets: allow('tweets', ds.tweets, TWEETS),
    clusters: ds.clusters.map((c) => allow('clusters[]', c, CLUSTER)),
    series: allow('series', ds.series, SERIES),
    inflections: ds.inflections.map((inf) => ({
      ...allow('inflections[]', inf, INFLECTION),
      causes: inf.causes.map((c) =>
        allow('inflections[].causes[]', c, {
          tweet: true,
          weight: true,
          reason: true
        })
      )
    })),
    people: allow('people', ds.people, PEOPLE),
    peopleTimeline: allow<PeopleTimeline>('peopleTimeline', ds.peopleTimeline, {
      t: true,
      people: true,
      closeness: true
    }),
    followerModel: {
      ...allow<FollowerModelInfo>('followerModel', ds.followerModel, {
        method: true,
        total: true,
        following: true,
        blocks: true,
        anchors: true
      }),
      anchors: ds.followerModel.anchors.map((a) =>
        allow('followerModel.anchors[]', a, { t: true, followers: true })
      )
    }
  }
}

// DM audit ---------------------------------------------------------------------

/** Characters per fingerprint window. */
const WINDOW = 40
/** Distance between a DM's fingerprints. */
const STRIDE = 20
const B1 = 0x01000193
const B2 = 0x5bd1e995

/** Case and whitespace differences shouldn't hide a match. */
export function normalizeForAudit(s: string): string {
  return s.toLowerCase().replace(/\s+/gu, ' ').trim()
}

const pow = (b: number, e: number) => {
  let r = 1
  for (let i = 0; i < e; i++) r = Math.imul(r, b)
  return r
}
const P1 = pow(B1, WINDOW - 1)
const P2 = pow(B2, WINDOW - 1)

/**
 * Calls `fn` with a 53-bit rolling hash of every WINDOW-long run of `s`
 * (two 32-bit polynomial hashes combined), and the run's start offset.
 */
function eachWindow(s: string, fn: (hash: number, at: number) => void) {
  if (s.length < WINDOW) return
  let h1 = 0
  let h2 = 0
  for (let i = 0; i < WINDOW; i++) {
    const c = s.charCodeAt(i)
    h1 = (Math.imul(h1, B1) + c) | 0
    h2 = (Math.imul(h2, B2) + c) | 0
  }
  const emit = (at: number) =>
    fn((h1 >>> 0) * 0x200000 + ((h2 >>> 0) & 0x1fffff), at)
  emit(0)
  for (let i = WINDOW; i < s.length; i++) {
    const out = s.charCodeAt(i - WINDOW)
    const c = s.charCodeAt(i)
    h1 = (Math.imul(h1 - Math.imul(out, P1), B1) + c) | 0
    h2 = (Math.imul(h2 - Math.imul(out, P2), B2) + c) | 0
    emit(i - WINDOW + 1)
  }
}

/** Packs (DM index, offset) into one number; DMs are at most 10k characters. */
const OFFSET = 0x10000
/**
 * Copying this much of one DM counts as a leak (two adjacent fingerprints),
 * as does copying a whole DM. Shorter overlaps are ordinary shared phrases,
 * e.g. an article title someone also pasted into a DM.
 */
export const LEAK_RUN = WINDOW + STRIDE

/**
 * Hashed fingerprints of DM text. Only hashes are kept, so the audit never
 * holds message text in memory longer than it takes to read a row, and a
 * failure report can't echo it.
 */
export class DmFingerprints {
  /** window hash → the first DM containing it, as dm * OFFSET + offset */
  private readonly windows = new Map<number, number>()
  /** fingerprints that also occur in public text */
  private readonly public = new Set<number>()
  /** normalized length of each fingerprinted DM */
  private readonly lengths: number[] = []
  messages = 0
  publicOverlap = 0

  get fingerprinted() {
    return this.lengths.length
  }

  addMessage(text: string) {
    this.messages++
    const s = normalizeForAudit(text)
    if (s.length < WINDOW) return
    const dm = this.lengths.push(s.length) - 1
    const last = s.length - WINDOW
    eachWindow(s, (h, at) => {
      if ((at % STRIDE === 0 || at === last) && !this.windows.has(h))
        this.windows.set(h, dm * OFFSET + Math.min(at, OFFSET - 1))
    })
  }

  /**
   * Marks DM passages that also appear in public text (your archive's
   * tweets). They still join runs, so private text next to them is caught,
   * but a run made only of public passages isn't a leak.
   */
  addPublic(text: string) {
    eachWindow(normalizeForAudit(text), (h) => {
      if (this.windows.has(h) && !this.public.has(h)) {
        this.public.add(h)
        this.publicOverlap++
      }
    })
  }

  /**
   * How much of a single DM appears verbatim in `text`, as the longest run
   * of consecutive fingerprints in DM order. `leak` is set when that run
   * includes private text and is the whole message or at least LEAK_RUN
   * characters.
   */
  overlap(text: string): { chars: number; leak: boolean } {
    const runs = new Map<
      string,
      { start: number; end: number; private: boolean }
    >()
    let chars = 0
    let leak = false
    eachWindow(normalizeForAudit(text), (h, at) => {
      const v = this.windows.get(h)
      if (v === undefined) return
      const dm = Math.floor(v / OFFSET)
      // Same DM, same alignment: consecutive fingerprints of one passage.
      const key = `${dm}:${at - (v % OFFSET)}`
      let run = runs.get(key)
      if (run && at <= run.end) run.end = at + WINDOW
      else {
        run = { start: at, end: at + WINDOW, private: false }
        runs.set(key, run)
      }
      run.private ||= !this.public.has(h)
      const length = run.end - run.start
      chars = Math.max(chars, length)
      leak ||= run.private && length >= Math.min(LEAK_RUN, this.lengths[dm]!)
    })
    return { chars, leak }
  }
}

function* strings(
  value: unknown,
  at: string
): Generator<[path: string, text: string]> {
  if (typeof value === 'string') yield [at, value]
  else if (Array.isArray(value)) {
    // Columns hold tens of thousands of numbers; only descend where text can be.
    for (let i = 0; i < value.length; i++) {
      const v: unknown = value[i]
      if (typeof v === 'string') yield [`${at}[${i}]`, v]
      else if (v && typeof v === 'object') yield* strings(v, `${at}[${i}]`)
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value))
      yield* strings(v, at ? `${at}.${k}` : k)
  }
}

const MAX_REPORTED = 20

/**
 * Scans every string in the export for DM text and for values that must
 * never be published (e.g. API keys, local paths). Reports field paths only.
 */
export function auditExport(
  data: unknown,
  dms: DmFingerprints,
  forbidden: { label: string; value: string }[] = []
): DmAudit {
  const banned = forbidden.filter((f) => f.value.length >= 8)
  const tweetIds = (data as { tweets?: { id?: unknown } }).tweets?.id
  const where = (at: string) => {
    const i = /^tweets\.\w+\[(\d+)\]$/u.exec(at)?.[1]
    const id = Array.isArray(tweetIds) && i ? tweetIds[Number(i)] : undefined
    return typeof id === 'string' ? `${at}, tweet ${id}` : at
  }
  const leaks: string[] = []
  let count = 0
  let chars = 0
  let total = 0
  let sharedPhrases = 0
  for (const [at, text] of strings(data, '')) {
    count++
    chars += text.length
    const reasons: string[] = []
    if (text.length >= WINDOW) {
      const o = dms.overlap(text)
      if (o.leak) reasons.push(`${o.chars} characters of a DM`)
      else if (o.chars) sharedPhrases++
    }
    for (const f of banned) if (text.includes(f.value)) reasons.push(f.label)
    if (!reasons.length) continue
    total++
    if (leaks.length < MAX_REPORTED)
      leaks.push(`${where(at)} (${reasons.join(', ')})`)
  }
  if (total > leaks.length) leaks.push(`…and ${total - leaks.length} more`)
  return {
    messages: dms.messages,
    fingerprinted: dms.fingerprinted,
    publicOverlap: dms.publicOverlap,
    sharedPhrases,
    strings: count,
    chars,
    leaks
  }
}
