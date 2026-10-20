import type { RawFollowSnapshot } from './load'
import { DAY, type LegacyUserIdClock } from './time'

/**
 * Reconstructs *when* each current follower followed you.
 *
 * X never exports follow timestamps, but two facts pin them down surprisingly
 * well:
 *
 * 1. The archive lists followers newest-first, in a handful of large blocks
 *    that are concatenated out of order. Within a block the order is
 *    chronological.
 * 2. Nobody can follow you before their account existed, and account creation
 *    time is encoded in snowflake user ids (and interpolated for legacy ids).
 *
 * So we (a) restore a global newest-first order by sorting positions on a
 * local time key, (b) take the running max of creation times from the oldest
 * end — a hard lower bound on each follow time — and (c) interpolate between
 * "record" accounts (brand-new accounts that followed right away), which are
 * tight anchors during periods of growth.
 */
export interface FollowReconstruction {
  /** profile id → estimated follow time (unix seconds) */
  followedAt: Map<string, number>
  /** ascending estimated follow times, one per member */
  times: Float64Array
  blocks: number
  records: number
  method: string
}

const WINDOW = 48
const RECORD_MIN_GAP = 2 * DAY

export function reconstructFollowTimes(
  snapshot: RawFollowSnapshot,
  clock: LegacyUserIdClock,
  options: { floor: number; ceiling: number }
): FollowReconstruction {
  const members = [...snapshot.members].sort((a, b) => a.position - b.position)
  const n = members.length
  if (n <= 1) {
    // Nothing to interpolate between: a lone follower followed somewhere
    // between their account's creation and the snapshot.
    const followedAt = new Map<string, number>()
    const times = new Float64Array(n)
    if (n === 1) {
      const c = clock.estimate(members[0]!.externalUserId)
      times[0] = Math.min(
        options.ceiling,
        Math.max(options.floor, c ?? options.floor)
      )
      followedAt.set(members[0]!.profileId, times[0])
    }
    return {
      followedAt,
      times,
      blocks: n,
      records: n,
      method: 'single snapshot member'
    }
  }
  const created = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const c = clock.estimate(members[i]!.externalUserId)
    created[i] = c === undefined ? Number.NaN : Math.min(c, options.ceiling)
  }

  // (a) Local time key: max creation time in a centered window. Within a
  // block it decreases with position; across blocks it jumps, which lets a
  // stable sort restore the global order without explicit block detection.
  const key = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let m = -Infinity
    const lo = Math.max(0, i - WINDOW / 2)
    const hi = Math.min(n, i + WINDOW / 2)
    for (let j = lo; j < hi; j++) {
      const c = created[j]!
      if (c > m) m = c
    }
    key[i] = Number.isFinite(m) ? m : options.floor
  }

  let blocks = 1
  for (let i = WINDOW; i < n; i += WINDOW) {
    if (key[i]! > key[i - WINDOW]! + 45 * DAY) blocks++
  }

  const order = Array.from({ length: n }, (_, i) => i)
  // Newest first; ties keep archive order.
  order.sort((a, b) => key[b]! - key[a]! || a - b)

  // (b) Oldest-first prefix max of creation times = lower bound on follow time.
  const oldestFirst = order.toReversed()
  const lower = new Float64Array(n)
  let runMax = options.floor
  const recordIdx: number[] = []
  const recordT: number[] = []
  for (let k = 0; k < n; k++) {
    const c = created[oldestFirst[k]!]!
    if (Number.isFinite(c) && c > runMax) {
      runMax = c
      if (!recordT.length || c - recordT.at(-1)! >= RECORD_MIN_GAP) {
        recordIdx.push(k)
        recordT.push(c)
      }
    }
    lower[k] = runMax
  }
  // The newest follower can't be later than the snapshot itself.
  if (!recordIdx.length || recordIdx.at(-1)! < n - 1) {
    recordIdx.push(n - 1)
    recordT.push(Math.max(options.ceiling, recordT.at(-1) ?? options.floor))
  }
  if (recordIdx[0]! > 0) {
    recordIdx.unshift(0)
    recordT.unshift(options.floor)
  }

  // (c) Interpolate between records (by rank), never below the lower bound.
  const times = new Float64Array(n)
  let r = 0
  for (let k = 0; k < n; k++) {
    while (r < recordIdx.length - 2 && recordIdx[r + 1]! <= k) r++
    const k0 = recordIdx[r]!
    const k1 = recordIdx[r + 1]!
    const t0 = recordT[r]!
    const t1 = recordT[r + 1]!
    const f = k1 === k0 ? 0 : (k - k0) / (k1 - k0)
    const t = Math.max(lower[k]!, t0 + f * (t1 - t0))
    times[k] = Math.min(t, options.ceiling)
  }
  // Enforce monotonicity after clamping.
  for (let k = 1; k < n; k++)
    if (times[k]! < times[k - 1]!) times[k] = times[k - 1]!

  const followedAt = new Map<string, number>()
  for (let k = 0; k < n; k++)
    followedAt.set(members[oldestFirst[k]!]!.profileId, times[k]!)

  return {
    followedAt,
    times,
    blocks,
    records: recordIdx.length,
    method:
      'Archive follower order restored by local creation-time keys; follow times are the running max of account creation (snowflake ids) interpolated between record accounts.'
  }
}

/** Count of reconstructed follows at or before each query time (times ascending). */
export function cumulativeAt(
  sortedTimes: Float64Array,
  queries: number[]
): number[] {
  const out: number[] = []
  let k = 0
  for (const q of queries) {
    while (k < sortedTimes.length && sortedTimes[k]! <= q) k++
    out.push(k)
  }
  return out
}
