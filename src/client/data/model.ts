import { FMT, FORMATS, type Dataset } from '../../shared/types'
import { oklchToLinear, type RGB } from './color'

export const KIND = { mine: 0, like: 1, bookmark: 2 } as const

/** Width of the shared time axis in world units. */
export const TIME_WIDTH = 26

/**
 * Typed, derived views over the dataset that layouts, search, and panels
 * share. Built once per dataset.
 */
export interface Model {
  ds: Dataset
  n: number
  t: Float64Array
  kind: Uint8Array
  likes: Float32Array
  rts: Float32Array
  /** likes + 2·reposts, 0 when unknown */
  eng: Float32Array
  /** log10(eng + 1) */
  logEng: Float32Array
  format: Uint8Array
  flags: Uint32Array
  cluster: Int16Array
  sem: Float32Array
  outlier: Float32Array
  lift: Float32Array
  seed: Float32Array
  textLower: string[]
  /** time domain shown on time axes, unix seconds */
  domain: [number, number]
  maxLogEng: number
  clusterColor: RGB[]
  /** richer, darker cluster tones for solid tiles */
  clusterColorDeep: RGB[]
  /** rank of each cluster by hue, so sorted stacks form smooth color bands */
  clusterHueRank: Int16Array
  /** my tweets that count for performance analysis (no retweets / thread continuations) */
  analyzable: Uint8Array
  timeToX: (t: number) => number
  xToTime: (x: number) => number
  years: number[]
  people: PeopleModel
}

export interface PeopleModel {
  n: number
  seed: Float32Array
  closeness: Float32Array
  /** per-person index into the quarterly timeline, -1 when not tracked */
  timelineRow: Int32Array
}

function hash01(i: number, salt = 0) {
  let h =
    Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^
    Math.imul(salt + 0x632be5ab, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return ((h >>> 0) % 1_000_003) / 1_000_003
}

export const rand = hash01

export function buildModel(ds: Dataset): Model {
  const tw = ds.tweets
  const n = tw.n
  const t = Float64Array.from(tw.t)
  const kind = Uint8Array.from(tw.kind)
  const likes = Float32Array.from(tw.likes)
  const rts = Float32Array.from(tw.rts)
  const eng = new Float32Array(n)
  const logEng = new Float32Array(n)
  let maxLogEng = 0
  for (let i = 0; i < n; i++) {
    eng[i] = Math.max(0, likes[i]!) + 2 * Math.max(0, rts[i]!)
    logEng[i] = Math.log10(eng[i]! + 1)
    if (kind[i] === KIND.mine && logEng[i]! > maxLogEng) maxLogEng = logEng[i]!
  }
  const format = Uint8Array.from(tw.format)
  const flags = Uint32Array.from(tw.flags)
  const sem = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    sem[i * 3] = tw.sx[i]!
    sem[i * 3 + 1] = tw.sy[i]!
    sem[i * 3 + 2] = tw.sz[i]!
  }
  const seed = new Float32Array(n)
  for (let i = 0; i < n; i++) seed[i] = hash01(i, 7)

  const analyzable = new Uint8Array(n)
  const retweetFormat = FORMATS.indexOf('retweet')
  for (let i = 0; i < n; i++) {
    analyzable[i] =
      kind[i] === KIND.mine &&
      format[i] !== retweetFormat &&
      !(flags[i]! & FMT.threadPart)
        ? 1
        : 0
  }

  // Time domain: start at the first year with meaningful activity so quiet
  // early years don't eat the axis.
  const perYear = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const y = new Date(t[i]! * 1000).getUTCFullYear()
    perYear.set(y, (perYear.get(y) ?? 0) + 1)
  }
  const accountYear = new Date(
    ds.meta.account.createdAt * 1000
  ).getUTCFullYear()
  let startYear = accountYear
  for (let y = accountYear; y < 2100; y++) {
    if ((perYear.get(y) ?? 0) >= Math.max(50, n * 0.004)) {
      startYear = y
      break
    }
  }
  const domain: [number, number] = [
    Date.UTC(startYear, 0, 1) / 1000,
    ds.meta.range.end
  ]
  const span = domain[1] - domain[0]
  const timeToX = (time: number) =>
    -TIME_WIDTH / 2 + ((time - domain[0]) / span) * TIME_WIDTH
  const xToTime = (x: number) =>
    domain[0] + ((x + TIME_WIDTH / 2) / TIME_WIDTH) * span
  const years: number[] = []
  for (let y = startYear; Date.UTC(y, 0, 1) / 1000 <= domain[1]; y++)
    years.push(y)

  // Cluster hues follow their position on the semantic map, so neighboring
  // topics read as related shades of the same nebula.
  const hues = ds.clusters.map(
    (c) =>
      ((Math.atan2(c.centroid[2], c.centroid[0]) * 180) / Math.PI + 360 + 210) %
      360
  )
  const clusterColor: RGB[] = ds.clusters.map((c, k) => {
    const l = 0.7 + Math.max(-0.08, Math.min(0.08, c.centroid[1] * 0.08))
    return oklchToLinear(l, 0.15, hues[k]!)
  })
  const clusterColorDeep: RGB[] = ds.clusters.map((_, k) =>
    oklchToLinear(0.6, 0.17, hues[k]!)
  )
  const clusterHueRank = new Int16Array(ds.clusters.length)
  ;[...hues.keys()]
    .sort((a, b) => hues[a]! - hues[b]!)
    .forEach((k, rank) => {
      clusterHueRank[k] = rank
    })

  const people = ds.people
  const timelineRow = new Int32Array(people.n).fill(-1)
  ds.peopleTimeline.people.forEach((p, row) => {
    timelineRow[p] = row
  })
  const pSeed = new Float32Array(people.n)
  for (let i = 0; i < people.n; i++) pSeed[i] = hash01(i, 13)

  return {
    ds,
    n,
    t,
    kind,
    likes,
    rts,
    eng,
    logEng,
    format,
    flags,
    cluster: Int16Array.from(tw.cluster),
    sem,
    outlier: Float32Array.from(tw.outlier),
    lift: Float32Array.from(tw.lift),
    seed,
    textLower: tw.text.map((s) => s.toLowerCase()),
    domain,
    maxLogEng: Math.max(1, maxLogEng),
    clusterColor,
    clusterColorDeep,
    clusterHueRank,
    analyzable,
    timeToX,
    xToTime,
    years,
    people: {
      n: people.n,
      seed: pSeed,
      closeness: Float32Array.from(people.closeness),
      timelineRow
    }
  }
}

/** Indices of tweets matching every whitespace-separated term of `query`. */
export function searchTweets(model: Model, query: string): Uint32Array {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return new Uint32Array()
  const out: number[] = []
  const texts = model.textLower
  outer: for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!
    for (const term of terms) if (!text.includes(term)) continue outer
    out.push(i)
  }
  return Uint32Array.from(out)
}
