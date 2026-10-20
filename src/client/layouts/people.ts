import { REL } from '../../shared/types'
import { REL_HEX, hexToLinear, mix, type RGB } from '../data/color'
import { rand, type Model } from '../data/model'
import type { Layout } from '../gl/ParticleField'
import { clamp01, emptyLayout, setRgb, setXyz } from './common'

const FOLLOWER = hexToLinear(REL_HEX.follower)
const FOLLOWING = hexToLinear(REL_HEX.following)
const MUTUAL = hexToLinear(REL_HEX.mutual)
const STAR: RGB = [1, 0.9, 0.75]

export const ORBIT = {
  inner: 1.2,
  close: 5.2,
  mutual: 5.9,
  following: 6.9,
  followers: 8.3,
  followersWidth: 2.4
}

const TAU = Math.PI * 2
const SEAM = 0.94

export function personRgb(rel: number): RGB {
  const follower = !!(rel & REL.follower)
  const following = !!(rel & REL.following)
  if (follower && following) return MUTUAL
  if (following) return FOLLOWING
  return FOLLOWER
}

/**
 * Time-aware closeness for one person: their quarterly score at `playhead`
 * when tracked, otherwise their overall score (zeroed before they appeared).
 */
export function closenessAt(
  model: Model,
  p: number,
  playhead: number | undefined
): number {
  const people = model.ds.people
  if (playhead === undefined) return people.closeness[p]!
  const row = model.people.timelineRow[p]!
  const tl = model.ds.peopleTimeline
  if (row >= 0) {
    let q = 0
    while (q < tl.t.length - 1 && tl.t[q + 1]! <= playhead) q++
    return tl.closeness[row * tl.t.length + q]!
  }
  return people.closeness[p]!
}

/** When did this person enter your orbit (best estimate)? */
export function arrivalTime(model: Model, p: number): number {
  const people = model.ds.people
  const row = model.people.timelineRow[p]!
  const candidates: number[] = []
  if (people.followedAt[p]! > 0) candidates.push(people.followedAt[p]!)
  if (people.followingAt[p]! > 0) candidates.push(people.followingAt[p]!)
  if (row >= 0) {
    const tl = model.ds.peopleTimeline
    for (let q = 0; q < tl.t.length; q++) {
      if (tl.closeness[row * tl.t.length + q]! > 0.02) {
        candidates.push(tl.t[q]!)
        break
      }
    }
  }
  return candidates.length ? Math.min(...candidates) : -1
}

/**
 * Orbit — you at the center; angle is when someone entered your orbit
 * (clockwise through time), radius is closeness. Followers form the outer
 * disc, people you follow a ring inside it, and the people you actually talk
 * with fall inward toward the star.
 */
export function computeArrivals(model: Model): Float64Array {
  const out = new Float64Array(model.ds.people.n)
  for (let p = 0; p < out.length; p++) out[p] = arrivalTime(model, p)
  return out
}

export function orbitLayout(
  model: Model,
  playhead: number | undefined,
  arrivals: Float64Array
): Layout {
  const { people } = model.ds
  const n = people.n
  const L = emptyLayout(n, `orbit:${playhead ?? 'now'}`)
  const [d0, d1] = model.domain
  const angleOf = (t: number, p: number) =>
    t > 0
      ? -(clamp01((t - d0) / (d1 - d0)) * SEAM * TAU) + Math.PI / 2
      : rand(p, 31) * TAU

  for (let p = 0; p < n; p++) {
    const rel = people.rel[p]!
    const seed = model.people.seed[p]!
    const arrival = arrivals[p]!
    const notYet = playhead !== undefined && (arrival < 0 || arrival > playhead)
    const c = closenessAt(model, p, playhead)
    const theta = angleOf(arrival, p) + (rand(p, 33) - 0.5) * 0.05
    // When time-traveling, relationships only count once they existed.
    const followedAt = people.followedAt[p]!
    const followingAt = people.followingAt[p]!
    const follower =
      !!(rel & REL.follower) &&
      (playhead === undefined || (followedAt > 0 && followedAt <= playhead))
    const following =
      !!(rel & REL.following) &&
      (playhead === undefined || (followingAt > 0 && followingAt <= playhead))
    const relNow =
      (rel & ~(REL.follower | REL.following)) |
      (follower ? REL.follower : 0) |
      (following ? REL.following : 0)

    let r: number
    let y: number
    if (c > 0.08) {
      r = ORBIT.inner + Math.pow(1 - c, 1.6) * (ORBIT.close - ORBIT.inner)
      y = (seed - 0.5) * 0.5 * (1 - c)
    } else if (follower && following) {
      r = ORBIT.mutual + (seed - 0.5) * 0.5
      y = (rand(p, 35) - 0.5) * 0.12
    } else if (following) {
      r = ORBIT.following + (seed - 0.5) * 0.45
      y = (rand(p, 35) - 0.5) * 0.12
    } else if (follower) {
      r = ORBIT.followers + Math.pow(seed, 0.8) * ORBIT.followersWidth
      y = (rand(p, 35) - 0.5) * 0.16 * (r / ORBIT.followers)
    } else {
      // Authors you liked or replied to who aren't in your graph.
      r = ORBIT.close + 0.2 + seed * 0.6
      y = (rand(p, 35) - 0.5) * 0.4
    }
    setXyz(L.position, p, Math.cos(theta) * r, y, Math.sin(theta) * r)

    const followers = people.followers[p]!
    const reach = followers > 0 ? clamp01((Math.log10(followers) - 2) / 4) : 0
    const base =
      relNow & (REL.follower | REL.following)
        ? personRgb(relNow)
        : mix(FOLLOWER, STAR, 0.4)
    const glow = Math.max(c, people.outlier[p]! > 0 ? 0.35 : 0)
    setRgb(
      L.color,
      p,
      mix(base, STAR, glow * 0.55),
      0.55 + glow * 2.2 + reach * 0.5
    )
    L.size[p] = 0.035 + reach * 0.07 + c * 0.2
    L.alpha[p] = notYet ? 0 : c > 0.08 ? 0.95 : 0.55 + reach * 0.3
    L.delay[p] =
      clamp01(r / (ORBIT.followers + ORBIT.followersWidth)) * 0.7 + seed * 0.3
  }
  L.glyph = 0
  // Playback re-targets ~20×/s: no stagger or swirl, just a quick glide, so
  // newly arrived people appear right away instead of waiting on delays.
  L.spread = playhead === undefined ? 0.6 : 0
  L.swirl = playhead === undefined ? 1.4 : 0
  L.duration = playhead === undefined ? 2.8 : 0.35
  L.shimmer = 0.008
  return L
}

/** People hide inside the star when another view is active. */
export function hiddenPeopleLayout(model: Model): Layout {
  const n = model.ds.people.n
  const L = emptyLayout(n, 'people:hidden')
  for (let p = 0; p < n; p++) {
    const r = 0.3 * rand(p, 41)
    const th = rand(p, 43) * TAU
    setXyz(
      L.position,
      p,
      Math.cos(th) * r,
      (rand(p, 45) - 0.5) * 0.2,
      Math.sin(th) * r
    )
    setRgb(L.color, p, STAR, 0.3)
    L.size[p] = 0.01
    L.alpha[p] = 0
    L.delay[p] = rand(p, 47)
  }
  L.glyph = 0
  L.spread = 0.4
  L.swirl = 1
  L.duration = 1.8
  return L
}
