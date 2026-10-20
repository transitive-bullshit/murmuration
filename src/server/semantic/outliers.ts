import type { Knn } from './knn'
import type { Clock } from './scheduler'

export interface RefineOptions {
  /** fraction of a doc's kNN that must share its cluster */
  minAgreement: number
  /** robust z-score below the cluster's median similarity that counts as an outlier */
  zCut: number
  /** clusters smaller than this (in documents) are dissolved into outliers */
  minClusterSize: number
  /** documents each row stands for (deduplicated input) */
  multiplicity?: Int32Array
  weights?: Float32Array
}

export interface RefinedClusters {
  k: number
  /** cluster per row, -1 for outliers; ids ordered by size (documents), largest first */
  labels: Int32Array
  /** for every row (outliers too): the most similar remaining cluster */
  nearest: Int32Array
  /** k × d unit centroids of the members */
  centroids: Float64Array
  sizes: Int32Array
  /** cosine similarity of each row to its own (or nearest) centroid */
  similarity: Float32Array
}

function dotRow(
  X: Float32Array,
  i: number,
  C: Float64Array,
  c: number,
  d: number
): number {
  let s = 0
  for (let t = 0; t < d; t++) s += X[i * d + t]! * C[c * d + t]!
  return s
}

function centroidsOf(
  X: Float32Array,
  m: number,
  d: number,
  labels: Int32Array,
  k: number,
  weight: (i: number) => number
) {
  const C = new Float64Array(k * d)
  for (let i = 0; i < m; i++) {
    const c = labels[i]!
    if (c < 0) continue
    const w = weight(i)
    for (let t = 0; t < d; t++) C[c * d + t]! += w * X[i * d + t]!
  }
  for (let c = 0; c < k; c++) {
    let norm = 0
    for (let t = 0; t < d; t++) norm += C[c * d + t]! ** 2
    const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0
    for (let t = 0; t < d; t++) C[c * d + t]! *= inv
  }
  return C
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[sorted.length >> 1]!
}

/**
 * Stop forcing every document into a topic: after k-means, a row becomes an
 * outlier (-1) when most of its nearest neighbors sit in other clusters, or
 * when it is unusually far from its cluster's centroid (robust z-score using
 * the median and MAD of that cluster's similarities). Clusters left too small
 * are dissolved; the rest are relabeled by size.
 */
export async function refineClusters(
  X: Float32Array,
  m: number,
  d: number,
  assignment: Int32Array,
  k: number,
  knn: Knn | undefined,
  options: RefineOptions,
  clock: Clock
): Promise<RefinedClusters> {
  const weight = (i: number) => Math.max(options.weights?.[i] ?? 1, 1e-6)
  const count = (i: number) => options.multiplicity?.[i] ?? 1
  const labels = Int32Array.from(assignment)

  let C = centroidsOf(X, m, d, labels, k, weight)
  const sim = new Float64Array(m)
  const byCluster: number[][] = Array.from({ length: k }, () => [])
  for (let i = 0; i < m; i++) {
    sim[i] = dotRow(X, i, C, labels[i]!, d)
    byCluster[labels[i]!]!.push(sim[i]!)
    if ((i & 1023) === 0 && clock.due()) await clock.pause()
  }
  const floor = byCluster.map((values) => {
    const med = median(values)
    const mad = median(values.map((v) => Math.abs(v - med))) * 1.4826
    return med - options.zCut * Math.max(mad, 1e-3)
  })

  for (let i = 0; i < m; i++) {
    const c = assignment[i]!
    let agree = 1
    if (knn) {
      let same = 0
      let total = 0
      for (let t = 0; t < knn.k; t++) {
        const j = knn.indices[i * knn.k + t]!
        if (j < 0) continue
        total++
        if (assignment[j] === c) same++
      }
      agree = total ? same / total : 1
    }
    if (agree < options.minAgreement || sim[i]! < floor[c]!) labels[i] = -1
  }

  // Dissolve clusters that lost most of their members, then relabel by size.
  const sizes = new Int32Array(k)
  for (let i = 0; i < m; i++)
    if (labels[i]! >= 0) sizes[labels[i]!]! += count(i)
  const order = Array.from({ length: k }, (_, c) => c)
    .filter((c) => sizes[c]! >= options.minClusterSize)
    .sort((a, b) => sizes[b]! - sizes[a]! || a - b)
  const remap = new Int32Array(k).fill(-1)
  order.forEach((c, rank) => (remap[c] = rank))
  for (let i = 0; i < m; i++)
    labels[i] = labels[i]! >= 0 ? remap[labels[i]!]! : -1
  const finalK = order.length

  C = centroidsOf(X, m, d, labels, finalK, weight)
  const nearest = new Int32Array(m)
  const similarity = new Float32Array(m)
  const finalSizes = new Int32Array(finalK)
  for (let i = 0; i < m; i++) {
    let best = labels[i]!
    let bestSim = best >= 0 ? dotRow(X, i, C, best, d) : -Infinity
    if (best < 0) {
      for (let c = 0; c < finalK; c++) {
        const s = dotRow(X, i, C, c, d)
        if (s > bestSim) {
          bestSim = s
          best = c
        }
      }
    } else finalSizes[best]! += count(i)
    nearest[i] = Math.max(best, 0)
    similarity[i] = Number.isFinite(bestSim) ? bestSim : 0
    if ((i & 255) === 0 && clock.due()) await clock.pause()
  }
  return {
    k: finalK,
    labels,
    nearest,
    centroids: C,
    sizes: finalSizes,
    similarity
  }
}
