import { FORMATS } from '../../shared/types'
import { FORMAT_HEX, KIND_HEX, hexToLinear, mix, type RGB } from '../data/color'
import { KIND, TIME_WIDTH, rand, type Model } from '../data/model'
import type { Layout } from '../gl/ParticleField'
import { utcYear, type AnatomyStats } from './anatomy'
import { clamp01, emptyLayout, engY, setRgb, setXyz } from './common'

const MINE = hexToLinear(KIND_HEX.mine)
const LIKE = hexToLinear(KIND_HEX.like)
const BOOKMARK = hexToLinear(KIND_HEX.bookmark)
const WARM_WHITE: RGB = [1, 0.86, 0.66]
const UNCLUSTERED: RGB = [0.1, 0.1, 0.12]

const clusterRgb = (model: Model, i: number): RGB =>
  model.clusterColor[model.cluster[i]!] ?? [0.4, 0.4, 0.45]

/** Constellation — every tweet placed by meaning (3D semantic map). */
export function constellationLayout(model: Model): Layout {
  const { n, sem, kind, logEng } = model
  const L = emptyLayout(n, 'constellation')
  const R = 8.6
  for (let i = 0; i < n; i++) {
    const x = sem[i * 3]! * R
    const y = sem[i * 3 + 1]! * R * 0.82
    const z = sem[i * 3 + 2]! * R
    setXyz(L.position, i, x, y, z)
    const base = clusterRgb(model, i)
    if (kind[i] === KIND.mine) {
      const glow = clamp01(logEng[i]! / 3.2)
      setRgb(
        L.color,
        i,
        mix(mix(base, MINE, 0.28), WARM_WHITE, glow * 0.45),
        1.5 + glow * 1.4
      )
      L.size[i] = 0.06 + 0.06 * logEng[i]!
      L.alpha[i] = 0.92
    } else if (model.cluster[i]! < 0) {
      // Unclustered (no usable words): faint dust.
      setRgb(L.color, i, [0.5, 0.52, 0.6], 0.3)
      L.size[i] = 0.035
      L.alpha[i] = 0.25
    } else {
      setRgb(
        L.color,
        i,
        kind[i] === KIND.bookmark ? mix(base, BOOKMARK, 0.5) : base,
        0.7
      )
      L.size[i] = 0.05
      L.alpha[i] = 0.5
    }
    // Burst outward from the center.
    L.delay[i] =
      clamp01(Math.hypot(x, y, z) / (R * 1.1)) * 0.85 + model.seed[i]! * 0.15
  }
  L.glyph = 0
  L.spread = 0.55
  L.swirl = 1.6
  L.duration = 2.9
  L.shimmer = 0.012
  return L
}

export interface StrataGeometry {
  pitch: number
  months: number
  frontDepth: number
  backDepth: number
  maxFront: number
  maxBack: number
}

/**
 * Strata — tweets stacked month by month into two walls (yours in front,
 * likes behind). Each column is sorted by topic so colors form layers.
 */
export function strataLayout(model: Model): {
  layout: Layout
  geometry: StrataGeometry
} {
  const { n, t, kind, domain } = model
  const L = emptyLayout(n, 'strata')
  const start = new Date(domain[0] * 1000)
  const startMonth = start.getUTCFullYear() * 12 + start.getUTCMonth()
  const end = new Date(domain[1] * 1000)
  const months = end.getUTCFullYear() * 12 + end.getUTCMonth() - startMonth + 1
  const pitch = TIME_WIDTH / months
  const tile = pitch * 0.8
  const maxHeight = 6.2
  const tilesHigh = Math.max(4, Math.floor(maxHeight / pitch))

  const columns: number[][][] = [
    Array.from({ length: months }, () => []),
    Array.from({ length: months }, () => [])
  ]
  const hidden: number[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date(t[i]! * 1000)
    const m = d.getUTCFullYear() * 12 + d.getUTCMonth() - startMonth
    if (m < 0 || m >= months) {
      hidden.push(i)
      continue
    }
    columns[kind[i] === KIND.mine ? 0 : 1]![m]!.push(i)
  }
  const maxCount = columns.map((wall) =>
    Math.max(1, ...wall.map((c) => c.length))
  )
  const depth = maxCount.map((m) => Math.max(1, Math.ceil(m / tilesHigh)))

  for (let w = 0; w < 2; w++) {
    const front = w === 0
    for (let m = 0; m < months; m++) {
      const col = columns[w]![m]!
      const rank = (i: number) =>
        model.cluster[i]! >= 0 ? model.clusterHueRank[model.cluster[i]!]! : 999
      col.sort((a, b) => rank(a) - rank(b) || t[a]! - t[b]!)
      const x = -TIME_WIDTH / 2 + (m + 0.5) * pitch
      col.forEach((i, j) => {
        const layer = Math.floor(j / depth[w]!)
        const k = j % depth[w]!
        const y = layer * pitch + pitch / 2
        const z = front ? 0.3 + k * pitch : -0.3 - k * pitch
        setXyz(L.position, i, x, y, z)
        const base = model.clusterColorDeep[model.cluster[i]!] ?? UNCLUSTERED
        // Deeper tones read as solid material under normal blending; yours sit
        // brighter in front, likes recede behind.
        setRgb(L.color, i, base, front ? 1 : 0.42)
        L.size[i] = tile
        L.alpha[i] = 1
        L.delay[i] =
          clamp01((x + TIME_WIDTH / 2) / TIME_WIDTH) * 0.8 +
          clamp01(y / maxHeight) * 0.2
      })
    }
  }
  for (const i of hidden) {
    setXyz(L.position, i, -TIME_WIDTH / 2 - 0.5, 0, 0)
    L.size[i] = 0
    L.alpha[i] = 0
  }
  L.glyph = 1
  L.spread = 0.6
  L.swirl = 1.1
  L.duration = 2.8
  L.shimmer = 0
  return {
    layout: L,
    geometry: {
      pitch,
      months,
      frontDepth: depth[0]! * pitch,
      backDepth: depth[1]! * pitch,
      maxFront: Math.ceil(maxCount[0]! / depth[0]!) * pitch,
      maxBack: Math.ceil(maxCount[1]! / depth[1]!) * pitch
    }
  }
}

const AMBER_DIM: RGB = hexToLinear('#5a4a3a')
const AMBER: RGB = hexToLinear('#e8a25a')
const AMBER_HOT: RGB = hexToLinear('#ffe2b0')

/** Engagement color: one warm hue, brighter the more a tweet beat your norm. */
export function liftRgb(lift: number): RGB {
  const v = clamp01(Math.log10(Math.max(lift, 0.1) + 0.5) / 2)
  return v < 0.5
    ? mix(AMBER_DIM, AMBER, v * 2)
    : mix(AMBER, AMBER_HOT, (v - 0.5) * 2)
}

/**
 * Growth — your tweets plotted by time × engagement (log), with the river of
 * likes along the floor behind them. The followers curve floats above.
 */
export function growthLayout(model: Model): Layout {
  const { n, t, kind, logEng, analyzable, seed, domain } = model
  const L = emptyLayout(n, 'growth')
  const replyFormat = FORMATS.indexOf('reply')
  for (let i = 0; i < n; i++) {
    const inDomain = t[i]! >= domain[0]
    const x = model.timeToX(Math.max(t[i]!, domain[0]))
    if (kind[i] === KIND.mine) {
      if (!analyzable[i] || !inDomain) {
        setXyz(L.position, i, x, -0.05, 0.6)
        L.alpha[i] = 0
        L.size[i] = 0.02
        continue
      }
      const isReply = model.format[i] === replyFormat
      const y = engY(logEng[i]!, model.maxLogEng)
      setXyz(
        L.position,
        i,
        x,
        y,
        (seed[i]! - 0.5) * 1.1 + (isReply ? -0.35 : 0.35)
      )
      setRgb(L.color, i, liftRgb(model.lift[i]!), isReply ? 0.9 : 1.5)
      L.size[i] = (isReply ? 0.045 : 0.06) + 0.035 * logEng[i]!
      L.alpha[i] = isReply ? 0.5 : 0.95
    } else {
      // Likes settle into a luminous river on the floor.
      setXyz(
        L.position,
        i,
        x,
        0.015 + rand(i, 3) * 0.02,
        -1.5 - rand(i, 5) * 2.6
      )
      setRgb(L.color, i, kind[i] === KIND.bookmark ? BOOKMARK : LIKE, 0.42)
      L.size[i] = 0.035
      L.alpha[i] = inDomain ? 0.32 : 0
    }
    L.delay[i] =
      clamp01((x + TIME_WIDTH / 2) / TIME_WIDTH) * 0.9 + seed[i]! * 0.1
  }
  L.glyph = 0
  L.spread = 0.6
  L.swirl = 1.3
  L.duration = 2.8
  L.shimmer = 0.006
  return L
}

/** Anatomy — your tweets grouped into columns, height = engagement, depth = year. */
export function anatomyLayout(model: Model, stats: AnatomyStats): Layout {
  const { n, logEng, seed, t } = model
  const L = emptyLayout(n, `anatomy:${stats.group}`)
  const G = stats.buckets.length
  const spacing = Math.min(3.1, 24 / Math.max(1, G))
  const years = stats.years
  const yearIndex = new Map(years.map((y, k) => [y, k]))
  const depth = 0.5
  // Default: everything not analyzed sinks below the floor and fades.
  for (let i = 0; i < n; i++) {
    setXyz(L.position, i, (seed[i]! - 0.5) * 26, -0.4, -4 + rand(i, 9) * 1.5)
    setRgb(L.color, i, LIKE, 0.25)
    L.size[i] = 0.02
    L.alpha[i] = 0
    L.delay[i] = seed[i]!
  }
  stats.buckets.forEach((b, g) => {
    const cx = (g - (G - 1) / 2) * spacing
    // Crowded columns (e.g. thousands of replies) dim so they don't dominate.
    const density = Math.min(
      1,
      Math.max(0.3, Math.sqrt(600 / Math.max(1, b.n)))
    )
    for (const i of b.members) {
      const yi = yearIndex.get(utcYear(t[i]!))
      if (yi === undefined) continue
      const z =
        (yi - (years.length - 1) / 2) * depth +
        (rand(i, 11) - 0.5) * depth * 0.8
      const x = cx + (seed[i]! - 0.5) * spacing * 0.62
      setXyz(L.position, i, x, engY(logEng[i]!, model.maxLogEng), z)
      const hot = clamp01(Math.log10(Math.max(model.lift[i]!, 0.1) + 0.5) / 2)
      setRgb(L.color, i, mix(b.rgb, WARM_WHITE, hot * 0.5), 0.9 + hot * 1.2)
      L.size[i] = 0.05 + 0.03 * logEng[i]!
      L.alpha[i] = 0.85 * density
      L.delay[i] = (g / Math.max(1, G)) * 0.7 + seed[i]! * 0.3
    }
  })
  L.glyph = 0
  L.spread = 0.55
  L.swirl = 1.2
  L.duration = 2.6
  L.shimmer = 0.006
  return L
}

/** Orbit — your tweets condense into the star at the center. */
export function sunLayout(model: Model): Layout {
  const { n, seed } = model
  const L = emptyLayout(n, 'sun')
  for (let i = 0; i < n; i++) {
    const r = 0.42 * Math.cbrt(rand(i, 21))
    const th = seed[i]! * Math.PI * 2
    const ph = Math.acos(1 - 2 * rand(i, 23))
    setXyz(
      L.position,
      i,
      r * Math.sin(ph) * Math.cos(th),
      r * Math.cos(ph),
      r * Math.sin(ph) * Math.sin(th)
    )
    setRgb(L.color, i, model.kind[i] === KIND.mine ? MINE : WARM_WHITE, 0.18)
    L.size[i] = 0.05
    L.alpha[i] = 0.5
    L.delay[i] = rand(i, 25)
  }
  L.glyph = 0
  L.spread = 0.5
  L.swirl = 2
  L.duration = 2.6
  L.shimmer = 0.03
  return L
}

export const formatRgb = (format: number) =>
  hexToLinear(FORMAT_HEX[FORMATS[format]!] ?? '#888888')
