// Time helpers. X ids are snowflakes: the top bits encode a millisecond
// timestamp, which lets us date tweets and (post-2016) accounts without any
// extra data.

const TWITTER_EPOCH_MS = 1288834974657n
// Snowflake user ids began around early 2016; older user ids are sequential.
const MIN_SNOWFLAKE_USER_ID = 100_000_000_000_000_000n

export const DAY = 86_400
export const WEEK = 7 * DAY

export function snowflakeSeconds(id: string): number | undefined {
  if (!/^\d{15,20}$/.test(id)) return undefined
  const ms = Number((BigInt(id) >> 22n) + TWITTER_EPOCH_MS)
  return Math.floor(ms / 1000)
}

export function isSnowflakeUserId(id: string): boolean {
  return /^\d+$/.test(id) && BigInt(id) >= MIN_SNOWFLAKE_USER_ID
}

export function parseIsoSeconds(
  value: string | null | undefined
): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms <= 86_400_000) return undefined
  return Math.floor(ms / 1000)
}

/** Monday 00:00 UTC of the week containing `t`. */
export function weekStart(t: number): number {
  const day = Math.floor(t / DAY)
  // 1970-01-01 was a Thursday; shift so weeks start on Monday.
  const dow = (day + 3) % 7
  return (day - dow) * DAY
}

export function quarterStart(t: number): number {
  const d = new Date(t * 1000)
  const q = Math.floor(d.getUTCMonth() / 3) * 3
  return Date.UTC(d.getUTCFullYear(), q, 1) / 1000
}

export function nextQuarter(t: number): number {
  const d = new Date(t * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1) / 1000
}

/**
 * Monotone id → account-creation-time map for legacy (sequential) user ids,
 * learned from profiles whose creation date we know.
 */
export class LegacyUserIdClock {
  private readonly ids: number[] = []
  private readonly times: number[] = []

  constructor(samples: Array<{ id: string; createdAt: number }>) {
    const legacy = samples
      .filter((s) => /^\d+$/.test(s.id) && !isSnowflakeUserId(s.id))
      .map((s) => ({ id: Number(s.id), t: s.createdAt }))
      .sort((a, b) => a.id - b.id)
    // Isotonic-ish cleanup: enforce non-decreasing times by id.
    let runMax = -Infinity
    for (const s of legacy) {
      runMax = Math.max(runMax, s.t)
      if (this.ids.length && this.ids.at(-1) === s.id) continue
      this.ids.push(s.id)
      this.times.push(runMax)
    }
  }

  get size() {
    return this.ids.length
  }

  /** Estimated creation time, or undefined when the id is outside the learned range. */
  estimate(id: string): number | undefined {
    if (isSnowflakeUserId(id)) return snowflakeSeconds(id)
    const x = Number(id)
    const { ids, times } = this
    if (!ids.length || !Number.isFinite(x)) return undefined
    if (x <= ids[0]!) return times[0]
    if (x >= ids.at(-1)!) return times.at(-1)
    let lo = 0
    let hi = ids.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (ids[mid]! <= x) lo = mid
      else hi = mid
    }
    const x0 = ids[lo]!
    const x1 = ids[hi]!
    const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0)
    return times[lo]! + f * (times[hi]! - times[lo]!)
  }
}
