export function median(values: ArrayLike<number>): number {
  const n = values.length
  if (!n) return 0
  const sorted = Float64Array.from(values).sort()
  const mid = n >> 1
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Median absolute deviation, scaled to be consistent with σ for normal data. */
export function mad(
  values: ArrayLike<number>,
  center = median(values)
): number {
  const n = values.length
  if (!n) return 0
  const dev = new Float64Array(n)
  for (let i = 0; i < n; i++) dev[i] = Math.abs(values[i]! - center)
  return 1.4826 * median(dev)
}

export function quantile(values: ArrayLike<number>, q: number): number {
  const n = values.length
  if (!n) return 0
  const sorted = Float64Array.from(values).sort()
  const pos = (n - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/**
 * For points sorted by time, returns the median and MAD of `values` within
 * ±`radius` of each point (two-pointer sliding window).
 */
export function rollingRobust(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  radius: number
): { center: Float64Array; spread: Float64Array; count: Int32Array } {
  const n = times.length
  const center = new Float64Array(n)
  const spread = new Float64Array(n)
  const count = new Int32Array(n)
  let lo = 0
  let hi = 0
  for (let i = 0; i < n; i++) {
    const t = times[i]!
    while (times[lo]! < t - radius) lo++
    while (hi < n && times[hi]! <= t + radius) hi++
    const window = Array.prototype.slice.call(values, lo, hi) as number[]
    const c = median(window)
    center[i] = c
    spread[i] = mad(window, c)
    count[i] = hi - lo
  }
  return { center, spread, count }
}

/** Centered rolling statistic over a dense series. */
export function rollingSeries(
  values: number[],
  radius: number,
  reduce: (window: number[]) => number
): number[] {
  return values.map((_, i) =>
    reduce(
      values.slice(
        Math.max(0, i - radius),
        Math.min(values.length, i + radius + 1)
      )
    )
  )
}

export const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
