import { TIME_WIDTH, rand, type Model } from '../data/model'
import type { BangerMode } from '../store'
import type { Layout } from '../gl/ParticleField'
import { clamp01, emptyLayout, setRgb, setXyz } from './common'
import { liftRgb } from './tweets'

export type { BangerMode } from '../store'

/** Height of the tallest stem in world units. */
export const BANGER_HEIGHT = 9.4
/** Outlier scores are drawn on a 0…OUTLIER_CAP scale (robust z). */
export const OUTLIER_CAP = 10
const MAX_BANGERS = 260

export interface Bangers {
  mode: BangerMode
  /** tweet indices, best first */
  ranked: number[]
  /** metric used for ranking/height, aligned with `ranked` */
  metric: number[]
  /** world-space top of each banger's stem, aligned with `ranked` */
  tops: [number, number, number][]
  maxLogEng: number
}

/**
 * Your standout tweets: the most engaging overall, or the biggest outliers
 * relative to what was typical for you at the time.
 */
export function selectBangers(
  model: Model,
  mode: BangerMode,
  range?: [number, number]
): Bangers {
  const candidates: number[] = []
  for (let i = 0; i < model.n; i++) {
    if (!model.analyzable[i] || model.t[i]! < model.domain[0]) continue
    if (range && (model.t[i]! < range[0] || model.t[i]! > range[1])) continue
    // Outliers on tiny numbers aren't bangers; require some real engagement.
    if (mode === 'outlier' && model.eng[i]! < 10) continue
    if (model.eng[i]! <= 0) continue
    candidates.push(i)
  }
  const score = (i: number) =>
    mode === 'engagement' ? model.eng[i]! : model.outlier[i]!
  candidates.sort((a, b) => score(b) - score(a))
  const ranked = candidates.slice(0, MAX_BANGERS)
  const maxLogEng = Math.max(1, ...ranked.map((i) => model.logEng[i]!))
  const tops = ranked.map((i): [number, number, number] => [
    model.timeToX(model.t[i]!),
    bangerY(model, i, mode, maxLogEng),
    (rand(i, 51) - 0.5) * 0.5
  ])
  return { mode, ranked, metric: ranked.map(score), tops, maxLogEng }
}

export function bangerY(
  model: Model,
  i: number,
  mode: BangerMode,
  maxLogEng: number
) {
  return mode === 'engagement'
    ? (model.logEng[i]! / maxLogEng) * BANGER_HEIGHT
    : clamp01(model.outlier[i]! / OUTLIER_CAP) * BANGER_HEIGHT * 0.96 +
        0.04 * BANGER_HEIGHT
}

/** Bangers glow at the top of their stems; everything else sinks away. */
export function bangersLayout(model: Model, bangers: Bangers): Layout {
  const { n, seed } = model
  const L = emptyLayout(n, `bangers:${bangers.mode}`)
  for (let i = 0; i < n; i++) {
    const x = (seed[i]! - 0.5) * TIME_WIDTH
    setXyz(L.position, i, x, -0.6, -2.5 + rand(i, 53) * 1.5)
    setRgb(L.color, i, [0.4, 0.45, 0.6], 0.2)
    L.size[i] = 0.02
    L.alpha[i] = 0
    L.delay[i] = seed[i]!
  }
  const count = bangers.ranked.length
  bangers.ranked.forEach((i, rank) => {
    const [x, y, z] = bangers.tops[rank]!
    setXyz(L.position, i, x, y, z)
    // Rank sets the glow: the very top burn white-hot.
    const heat = 1 - rank / Math.max(1, count)
    const rgb = liftRgb(Math.max(model.lift[i]!, 1 + heat * 60))
    setRgb(L.color, i, rgb, 1.2 + heat * 1.8)
    L.size[i] = 0.09 + 0.07 * model.logEng[i]! * (0.6 + heat * 0.4)
    L.alpha[i] = 1
    L.delay[i] =
      clamp01((x + TIME_WIDTH / 2) / TIME_WIDTH) * 0.8 + seed[i]! * 0.2
  })
  L.glyph = 0
  L.spread = 0.6
  L.swirl = 1.3
  L.duration = 2.6
  L.shimmer = 0.004
  return L
}
