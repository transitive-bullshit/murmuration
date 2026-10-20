import type { Rng } from './random'
import type { Clock } from './scheduler'

export interface KMeansOptions {
  k: number
  rng: Rng
  clock: Clock
  weights?: Float32Array
  /** documents each row stands for (deduplicated input); used for cluster sizes */
  multiplicity?: Int32Array
  maxIterations?: number
  onProgress?: (fraction: number) => void
}

export interface KMeansResult {
  k: number
  /** cluster per row, 0..k-1, ordered by cluster size (in documents) descending */
  assignment: Int32Array
  /** k × d unit centroids */
  centroids: Float64Array
  sizes: Int32Array
  /** cosine similarity of each row to its centroid */
  similarity: Float32Array
}

type Weight = (i: number) => number

function dot(
  X: Float32Array,
  xo: number,
  C: Float64Array,
  co: number,
  d: number
): number {
  // Four accumulators let the JIT overlap the multiply-adds.
  let s0 = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  let t = 0
  for (; t + 3 < d; t += 4) {
    s0 += X[xo + t]! * C[co + t]!
    s1 += X[xo + t + 1]! * C[co + t + 1]!
    s2 += X[xo + t + 2]! * C[co + t + 2]!
    s3 += X[xo + t + 3]! * C[co + t + 3]!
  }
  for (; t < d; t++) s0 += X[xo + t]! * C[co + t]!
  return s0 + s1 + s2 + s3
}

function normalizeInto(C: Float64Array, co: number, d: number): boolean {
  let norm = 0
  for (let t = 0; t < d; t++) norm += C[co + t]! ** 2
  if (norm <= 1e-24) return false
  const inv = 1 / Math.sqrt(norm)
  for (let t = 0; t < d; t++) C[co + t]! *= inv
  return true
}

function pickWeighted(rng: Rng, scores: Float64Array, total: number): number {
  let target = rng() * total
  for (let i = 0; i < scores.length; i++) {
    target -= scores[i]!
    if (target <= 0 && scores[i]! > 0) return i
  }
  for (let i = scores.length - 1; i >= 0; i--) if (scores[i]! > 0) return i
  return 0
}

/** Weighted k-means++: sample proportionally to weight × (1 − cos) to the nearest seed. */
async function seedCentroids(
  X: Float32Array,
  m: number,
  d: number,
  k: number,
  weight: Weight,
  rng: Rng,
  clock: Clock
): Promise<Float64Array> {
  const C = new Float64Array(k * d)
  const dist = new Float64Array(m).fill(Infinity)
  const scores = new Float64Array(m)
  let total = 0
  for (let i = 0; i < m; i++) total += scores[i] = weight(i)
  let seed = pickWeighted(rng, scores, total)
  for (let c = 0; c < k; c++) {
    for (let t = 0; t < d; t++) C[c * d + t] = X[seed * d + t]!
    if (c === k - 1) break
    total = 0
    for (let i = 0; i < m; i++) {
      const di = Math.max(0, 1 - dot(X, i * d, C, c * d, d))
      if (di < dist[i]!) dist[i] = di
      total += scores[i] = weight(i) * dist[i]!
    }
    if (clock.due()) await clock.pause()
    seed = total > 0 ? pickWeighted(rng, scores, total) : (c + 1) % m
  }
  return C
}

/** Lloyd iterations; C is updated in place and matches the returned assignment. */
async function lloyd(
  X: Float32Array,
  m: number,
  d: number,
  C: Float64Array,
  k: number,
  weight: Weight,
  maxIterations: number,
  clock: Clock,
  progress: (fraction: number) => void
): Promise<{ assignment: Int32Array; similarity: Float64Array }> {
  const assignment = new Int32Array(m).fill(-1)
  const similarity = new Float64Array(m)
  const sizes = new Int32Array(k)
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = 0
    for (let i = 0; i < m; i++) {
      const xo = i * d
      let best = 0
      let bestSim = -Infinity
      for (let c = 0; c < k; c++) {
        const s = dot(X, xo, C, c * d, d)
        if (s > bestSim) {
          bestSim = s
          best = c
        }
      }
      if (assignment[i] !== best) changed++
      assignment[i] = best
      similarity[i] = bestSim
      if ((i & 1023) === 0 && clock.due()) {
        progress((iter + i / m) / maxIterations)
        await clock.pause()
      }
    }
    if ((changed <= m * 0.0005 && iter > 0) || iter === maxIterations - 1) break

    C.fill(0)
    sizes.fill(0)
    for (let i = 0; i < m; i++) {
      const c = assignment[i]!
      const w = weight(i)
      sizes[c]!++
      const co = c * d
      const xo = i * d
      for (let t = 0; t < d; t++) C[co + t]! += w * X[xo + t]!
    }
    const reseeded = new Set<number>()
    for (let c = 0; c < k; c++) {
      if (sizes[c]! > 0 && normalizeInto(C, c * d, d)) continue
      // Re-seed an empty cluster with the point that fits its centroid worst.
      let worst = -1
      for (let i = 0; i < m; i++) {
        if (reseeded.has(i)) continue
        if (worst < 0 || similarity[i]! < similarity[worst]!) worst = i
      }
      reseeded.add(worst)
      for (let t = 0; t < d; t++) C[c * d + t] = X[worst * d + t]!
    }
  }
  return { assignment, similarity }
}

/**
 * Spherical (cosine) k-means over unit rows X (m × d) with weighted
 * k-means++ seeding. Clusters are relabeled by size, largest first.
 */
export async function sphericalKMeans(
  X: Float32Array,
  m: number,
  d: number,
  options: KMeansOptions
): Promise<KMeansResult> {
  const { rng, clock } = options
  const k = Math.max(1, Math.min(options.k, m))
  const progress = options.onProgress ?? (() => {})
  const weight: Weight = (i) => Math.max(options.weights?.[i] ?? 1, 1e-6)

  const C = await seedCentroids(X, m, d, k, weight, rng, clock)
  progress(0.1)
  const { assignment } = await lloyd(
    X,
    m,
    d,
    C,
    k,
    weight,
    options.maxIterations ?? 30,
    clock,
    (f) => progress(0.1 + 0.85 * f)
  )

  const similarity = new Float32Array(m)
  const sizes = new Int32Array(k)
  for (let i = 0; i < m; i++) {
    const c = assignment[i]!
    similarity[i] = dot(X, i * d, C, c * d, d)
    sizes[c]! += options.multiplicity?.[i] ?? 1
  }

  // Relabel clusters by size (descending), dropping empty ones.
  const order = Array.from({ length: k }, (_, c) => c)
    .filter((c) => sizes[c]! > 0)
    .sort((a, b) => sizes[b]! - sizes[a]! || a - b)
  const remap = new Int32Array(k).fill(-1)
  order.forEach((c, rank) => (remap[c] = rank))
  const centroids = new Float64Array(order.length * d)
  const finalSizes = new Int32Array(order.length)
  order.forEach((c, rank) => {
    finalSizes[rank] = sizes[c]!
    for (let t = 0; t < d; t++) centroids[rank * d + t] = C[c * d + t]!
  })
  const finalAssignment = assignment.map((c) => remap[c]!)
  progress(1)
  return {
    k: order.length,
    assignment: finalAssignment,
    centroids,
    sizes: finalSizes,
    similarity
  }
}
