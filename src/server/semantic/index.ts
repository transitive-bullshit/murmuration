import { buildCorpus } from './corpus'
import { groupDuplicates } from './dedupe'
import { sphericalKMeans } from './kmeans'
import { approximateKnn, smoothByNeighbors, type Knn } from './knn'
import { labelClusters } from './labels'
import {
  clusterAnchors,
  expandDuplicates,
  layout3d,
  normalizeCoords
} from './layout'
import { deriveRng, gaussian, type Rng } from './random'
import { createClock } from './scheduler'
import { lsa } from './svd'
import { buildTfIdf } from './tfidf'

export { extractTerms, tokenize } from './tokenize'

export interface SemanticOptions {
  /** number of clusters; default: choose ~sqrt(n/40) clamped to [12, 36] */
  k?: number
  seed?: number // default 42
  /** optional per-document weight (e.g. 1.0 for the user's own tweets, 0.6 for likes); used to weight centroids/labels, not required */
  weights?: Float32Array
  onProgress?: (phase: string, fraction: number) => void
}

export interface SemanticResult {
  coords: Float32Array // n*3, centered, scaled so ~98% of points lie within the unit sphere
  cluster: Int16Array // n, cluster id per doc; -1 only for docs with no usable tokens
  clusters: Array<{
    id: number
    label: string
    terms: string[]
    size: number
    centroid: [number, number, number]
  }>
  timings: Record<string, number> // ms per phase
}

const LSA_RANK = 96
const N_NEIGHBORS = 15
const SMOOTHING = 1
// Label terms come from cluster cores: doc weight ∝ similarity^LABEL_FOCUS.
const LABEL_FOCUS = 6

export function defaultK(n: number): number {
  return Math.min(36, Math.max(12, Math.round(Math.sqrt(n / 40))))
}

/** Points uniformly distributed in the unit ball. */
function dust(n: number, rng: Rng): Float32Array {
  const coords = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const v = [gaussian(rng), gaussian(rng), gaussian(rng)]
    const scale = Math.cbrt(rng()) / (Math.hypot(v[0]!, v[1]!, v[2]!) || 1)
    for (let c = 0; c < 3; c++) coords[i * 3 + c] = v[c]! * scale
  }
  return coords
}

/**
 * Offline topic map of short texts:
 * tokenize → TF-IDF → randomized SVD (LSA) → kNN graph → spherical k-means on
 * kNN-smoothed vectors → c-TF-IDF labels → 3D UMAP layout.
 * Deterministic for a given seed; yields to the event loop every ~20 ms.
 */
export async function buildSemanticMap(
  texts: string[],
  options: SemanticOptions = {}
): Promise<SemanticResult> {
  const seed = options.seed ?? 42
  const report = options.onProgress ?? (() => {})
  const clock = createClock(20)
  const timings: Record<string, number> = {}
  const n = texts.length
  const started = performance.now()
  let phaseStart = started
  const begin = (phase: string) => {
    phaseStart = performance.now()
    report(phase, 0)
  }
  const end = (phase: string) => {
    timings[phase] = performance.now() - phaseStart
    report(phase, 1)
  }

  begin('tokenizing')
  const corpus = await buildCorpus(texts, clock, (f) => report('tokenizing', f))
  end('tokenizing')

  begin('tf-idf')
  const tfidf = buildTfIdf(corpus)
  await clock.pause()
  end('tf-idf')

  const unclustered = (): SemanticResult => {
    timings.total = performance.now() - started
    return {
      coords: dust(n, deriveRng(seed, 3)),
      cluster: new Int16Array(n).fill(-1),
      clusters: [],
      timings
    }
  }
  if (tfidf.matrix.indices.length === 0) return unclustered()

  begin('svd')
  const embedding = await lsa(tfidf.matrix, {
    rank: LSA_RANK,
    rng: deriveRng(seed, 1),
    clock,
    onProgress: (f) => report('svd', f)
  })
  end('svd')

  // Only documents with a non-zero LSA vector take part in clustering/layout;
  // identical vectors are processed once.
  const d = embedding.dims
  const usable: number[] = []
  for (let i = 0; i < n; i++) if (embedding.captured[i]! > 1e-6) usable.push(i)
  const m = usable.length
  if (m === 0) return unclustered()
  const X = new Float32Array(m * d)
  usable.forEach((src, i) =>
    X.set(embedding.vectors.subarray(src * d, (src + 1) * d), i * d)
  )
  const { unique, groupOf } = groupDuplicates(X, m, d)
  const mu = unique.length
  const Xu = new Float32Array(mu * d)
  unique.forEach((src, u) => Xu.set(X.subarray(src * d, (src + 1) * d), u * d))
  // Docs the LSA subspace barely captures (mostly rare terms) have unreliable
  // directions after normalization; weight by captured energy so they
  // neither seed nor drag centroids.
  const weightU = new Float32Array(mu)
  const multiplicity = new Int32Array(mu)
  usable.forEach((src, i) => {
    const u = groupOf[i]!
    weightU[u]! += (options.weights?.[src] ?? 1) * embedding.captured[src]! ** 2
    multiplicity[u]!++
  })

  begin('neighbors')
  let knn: Knn | undefined
  if (mu > 2) {
    knn = await approximateKnn(Xu, mu, d, {
      k: Math.min(N_NEIGHBORS - 1, mu - 1),
      rng: deriveRng(seed, 4),
      clock,
      onProgress: (f) => report('neighbors', f)
    })
  }
  end('neighbors')

  begin('clustering')
  const features = knn
    ? await smoothByNeighbors(Xu, mu, d, knn, SMOOTHING, clock)
    : Xu
  const km = await sphericalKMeans(features, mu, d, {
    k: options.k ?? defaultK(m),
    rng: deriveRng(seed, 2),
    clock,
    weights: weightU,
    multiplicity,
    onProgress: (f) => report('clustering', f)
  })
  const cluster = new Int16Array(n).fill(-1)
  usable.forEach((src, i) => (cluster[src] = km.assignment[groupOf[i]!]!))
  end('clustering')

  begin('labeling')
  // Label from each cluster's core: docs close to the centroid dominate.
  const labelWeights = new Float32Array(n)
  usable.forEach((src, i) => {
    const sim = Math.max(0, km.similarity[groupOf[i]!]!)
    labelWeights[src] = (options.weights?.[src] ?? 1) * sim ** LABEL_FOCUS
  })
  const labels = labelClusters(tfidf.matrix, tfidf.vocab, cluster, km.k, {
    weights: labelWeights
  })
  end('labeling')

  begin('projecting')
  const layoutRng = deriveRng(seed, 3)
  const anchors = clusterAnchors(km.centroids, km.k, d, layoutRng)
  const unitCoords = await layout3d(knn, mu, km.assignment, anchors, {
    rng: layoutRng,
    clock,
    onProgress: (f) => report('projecting', f)
  })
  const docCoords = expandDuplicates(unitCoords, unique, groupOf, layoutRng)
  normalizeCoords(docCoords, m)

  // Docs without usable tokens become "dust" spread through the unit ball.
  const coords = dust(n, layoutRng)
  usable.forEach((src, i) =>
    coords.set(docCoords.subarray(i * 3, i * 3 + 3), src * 3)
  )

  const sums = new Float64Array(km.k * 3)
  for (let i = 0; i < m; i++) {
    const c = km.assignment[groupOf[i]!]!
    for (let t = 0; t < 3; t++) sums[c * 3 + t]! += docCoords[i * 3 + t]!
  }
  const clusters = labels.map((info, id) => {
    const size = km.sizes[id]!
    const centroid: [number, number, number] = [
      sums[id * 3]! / size,
      sums[id * 3 + 1]! / size,
      sums[id * 3 + 2]! / size
    ]
    return { id, label: info.label, terms: info.terms, size, centroid }
  })
  end('projecting')

  timings.total = performance.now() - started
  return { coords, cluster, clusters, timings }
}
