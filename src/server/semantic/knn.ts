import { randInt, type Rng } from './random'
import type { Clock } from './scheduler'

export interface Knn {
  k: number
  /** m × k neighbor ids, nearest first (self excluded) */
  indices: Int32Array
  /** m × k euclidean distances, ascending */
  distances: Float32Array
}

export interface KnnOptions {
  k: number
  rng: Rng
  clock: Clock
  trees?: number
  leafSize?: number
  refineIterations?: number
  onProgress?: (fraction: number) => void
}

function dot(X: Float32Array, a: number, b: number, d: number): number {
  // Four accumulators let the JIT overlap the multiply-adds.
  let s0 = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  const ao = a * d
  const bo = b * d
  let t = 0
  for (; t + 3 < d; t += 4) {
    s0 += X[ao + t]! * X[bo + t]!
    s1 += X[ao + t + 1]! * X[bo + t + 1]!
    s2 += X[ao + t + 2]! * X[bo + t + 2]!
    s3 += X[ao + t + 3]! * X[bo + t + 3]!
  }
  for (; t < d; t++) s0 += X[ao + t]! * X[bo + t]!
  return s0 + s1 + s2 + s3
}

/** Per-point bounded min-heaps keyed by similarity (worst neighbor at the root). */
class NeighborHeaps {
  readonly ids: Int32Array
  readonly sims: Float32Array
  constructor(
    readonly m: number,
    readonly k: number
  ) {
    this.ids = new Int32Array(m * k).fill(-1)
    this.sims = new Float32Array(m * k).fill(-Infinity)
  }

  push(i: number, j: number, s: number): boolean {
    const { ids, sims, k } = this
    const o = i * k
    if (s <= sims[o]!) return false
    for (let t = 0; t < k; t++) if (ids[o + t] === j) return false
    // Replace the root and sift down.
    let pos = 0
    for (;;) {
      const l = 2 * pos + 1
      if (l >= k) break
      const r = l + 1
      const child = r < k && sims[o + r]! < sims[o + l]! ? r : l
      if (sims[o + child]! >= s) break
      sims[o + pos] = sims[o + child]!
      ids[o + pos] = ids[o + child]!
      pos = child
    }
    sims[o + pos] = s
    ids[o + pos] = j
    return true
  }
}

/** Partition `order` into random-projection-tree leaves of at most `leafSize` points. */
async function buildLeaves(
  X: Float32Array,
  m: number,
  d: number,
  leafSize: number,
  rng: Rng,
  clock: Clock
): Promise<Array<[number, number, Int32Array]>> {
  const order = new Int32Array(m)
  for (let i = 0; i < m; i++) order[i] = i
  const leaves: Array<[number, number, Int32Array]> = []
  const stack: Array<[number, number]> = [[0, m]]
  const normal = new Float64Array(d)
  const side = new Float64Array(m)
  while (stack.length) {
    const [start, end] = stack.pop()!
    const size = end - start
    if (size <= leafSize) {
      leaves.push([start, end, order])
      continue
    }
    const a = order[start + randInt(rng, size)]!
    let b = order[start + randInt(rng, size)]!
    for (let tries = 0; b === a && tries < 4; tries++)
      b = order[start + randInt(rng, size)]!
    let offset = 0
    for (let t = 0; t < d; t++) {
      const xa = X[a * d + t]!
      const xb = X[b * d + t]!
      normal[t] = xa - xb
      offset += (xa - xb) * (xa + xb) * 0.5
    }
    for (let p = start; p < end; p++) {
      const i = order[p]!
      let s = -offset
      for (let t = 0; t < d; t++) s += X[i * d + t]! * normal[t]!
      side[p] = s === 0 ? rng() - 0.5 : s
    }
    // In-place partition: negative margins first.
    let lo = start
    let hi = end - 1
    while (lo <= hi) {
      if (side[lo]! < 0) lo++
      else {
        const ti = order[lo]!
        order[lo] = order[hi]!
        order[hi] = ti
        const ts = side[lo]!
        side[lo] = side[hi]!
        side[hi] = ts
        hi--
      }
    }
    let mid = lo
    // Degenerate split (duplicates): fall back to halving.
    if (mid === start || mid === end) mid = start + (size >> 1)
    stack.push([mid, end], [start, mid])
    if (clock.due()) await clock.pause()
  }
  return leaves
}

/**
 * Approximate k nearest neighbors (cosine on unit rows, reported as
 * euclidean distance) from a random-projection forest followed by
 * NN-descent style "neighbors of neighbors" refinement.
 */
export async function approximateKnn(
  X: Float32Array,
  m: number,
  d: number,
  options: KnnOptions
): Promise<Knn> {
  const { rng, clock } = options
  const k = Math.max(1, Math.min(options.k, m - 1))
  const trees = options.trees ?? 8
  const leafSize = Math.max(options.leafSize ?? 32, k + 1)
  const refine = options.refineIterations ?? 2
  const progress = options.onProgress ?? (() => {})
  const heaps = new NeighborHeaps(m, k)
  const totalSteps = trees + refine

  for (let tree = 0; tree < trees; tree++) {
    const leaves = await buildLeaves(X, m, d, leafSize, rng, clock)
    for (const [start, end, order] of leaves) {
      for (let p = start; p < end; p++) {
        const i = order[p]!
        for (let q = p + 1; q < end; q++) {
          const j = order[q]!
          const s = dot(X, i, j, d)
          heaps.push(i, j, s)
          heaps.push(j, i, s)
        }
      }
      if (clock.due()) {
        progress(tree / totalSteps)
        await clock.pause()
      }
    }
  }

  // Local join: neighbors (and reverse neighbors) of a point are compared
  // with each other; repeat while it still finds improvements.
  const reverse = new Int32Array(m * k).fill(-1)
  const reverseCount = new Int32Array(m)
  const pool = new Int32Array(2 * k)
  for (let it = 0; it < refine; it++) {
    reverse.fill(-1)
    reverseCount.fill(0)
    for (let i = 0; i < m; i++) {
      for (let t = 0; t < k; t++) {
        const j = heaps.ids[i * k + t]!
        if (j >= 0 && reverseCount[j]! < k)
          reverse[j * k + reverseCount[j]!++] = i
      }
    }
    let updates = 0
    for (let v = 0; v < m; v++) {
      let size = 0
      for (let t = 0; t < k; t++) {
        const j = heaps.ids[v * k + t]!
        if (j >= 0) pool[size++] = j
      }
      for (let t = 0; t < reverseCount[v]!; t++)
        pool[size++] = reverse[v * k + t]!
      for (let a = 0; a < size; a++) {
        const i = pool[a]!
        for (let b = a + 1; b < size; b++) {
          const j = pool[b]!
          if (i === j) continue
          const s = dot(X, i, j, d)
          if (heaps.push(i, j, s)) updates++
          if (heaps.push(j, i, s)) updates++
        }
      }
      if ((v & 127) === 0 && clock.due()) {
        progress((trees + it + v / m) / totalSteps)
        await clock.pause()
      }
    }
    if (updates < 0.001 * m * k) break
  }

  // Sort each heap into ascending distance order.
  const indices = new Int32Array(m * k)
  const distances = new Float32Array(m * k)
  const slot = Array.from({ length: k }, (_, t) => t)
  for (let i = 0; i < m; i++) {
    const o = i * k
    slot.sort(
      (a, b) =>
        heaps.sims[o + b]! - heaps.sims[o + a]! ||
        heaps.ids[o + a]! - heaps.ids[o + b]!
    )
    for (let t = 0; t < k; t++) {
      const src = o + slot[t]!
      const s = heaps.sims[src]!
      indices[o + t] = heaps.ids[src]!
      distances[o + t] = Number.isFinite(s)
        ? Math.sqrt(Math.max(0, 2 - 2 * s))
        : Infinity
    }
    if ((i & 1023) === 0 && clock.due()) await clock.pause()
  }
  progress(1)
  return { k, indices, distances }
}

/**
 * One step of graph diffusion: blend each row with the mean of its neighbors
 * and re-normalize. Denoises short, sparse documents and makes clusters agree
 * with the kNN graph the layout is built from.
 */
export async function smoothByNeighbors(
  X: Float32Array,
  m: number,
  d: number,
  knn: Knn,
  alpha: number,
  clock: Clock
): Promise<Float32Array> {
  const { k, indices } = knn
  const out = new Float32Array(m * d)
  const acc = new Float64Array(d)
  for (let i = 0; i < m; i++) {
    acc.fill(0)
    let count = 0
    for (let t = 0; t < k; t++) {
      const j = indices[i * k + t]!
      if (j < 0) continue
      count++
      for (let c = 0; c < d; c++) acc[c]! += X[j * d + c]!
    }
    const w = count ? alpha / count : 0
    let norm = 0
    for (let c = 0; c < d; c++) {
      const v = X[i * d + c]! + w * acc[c]!
      acc[c] = v
      norm += v * v
    }
    const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0
    for (let c = 0; c < d; c++) out[i * d + c] = acc[c]! * inv
    if ((i & 1023) === 0 && clock.due()) await clock.pause()
  }
  return out
}
