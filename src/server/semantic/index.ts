import { buildCorpus } from './corpus'
import { groupDuplicates } from './dedupe'
import { sphericalKMeans } from './kmeans'
import { approximateKnn, smoothByNeighbors, type Knn } from './knn'
import { imputeFromText } from './impute'
import { labelClusters } from './labels'
import { refineClusters } from './outliers'
import { pcaProject } from './pca'
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

export { captionTerms, extractTerms, tokenize } from './tokenize'

export interface SemanticOptions {
  /** number of k-means clusters before outlier refinement; default ~sqrt(n/40) clamped to [12, 36] */
  k?: number
  seed?: number // default 42
  /** optional per-document weight (e.g. 1.0 for the user's own tweets, 0.6 for likes); used to weight centroids/labels, not required */
  weights?: Float32Array
  /**
   * Precomputed L2-normalized document embeddings (n × dim). When given they
   * drive neighbors, clustering and layout; TF-IDF is still used for labels.
   * All-zero rows mark documents without an embedding: those with text are
   * imputed from their nearest TF-IDF neighbors, the rest stay unclustered.
   */
  vectors?: Float32Array
  dim?: number
  /** advanced; the defaults are calibrated on a ~50k tweet archive */
  tuning?: Partial<Tuning>
  onProgress?: (phase: string, fraction: number) => void
}

export interface Tuning {
  /** blend of each row with its neighbors' mean before k-means */
  smoothing: number
  /** share of a doc's kNN that must share its cluster */
  minAgreement: number
  /** robust z-score below the cluster's median similarity that makes an outlier */
  zCut: number
}

const DEFAULT_TUNING: Tuning = { smoothing: 1, minAgreement: 0.3, zCut: 2 }

export interface SemanticResult {
  coords: Float32Array // n*3, centered, scaled so ~98% of points lie within the unit sphere
  /** n, cluster id per doc; -1 for docs with nothing usable or that fit no topic confidently */
  cluster: Int16Array
  clusters: Array<{
    id: number
    label: string
    terms: string[]
    size: number
    centroid: [number, number, number]
  }>
  timings: Record<string, number> // ms per phase
  /** documents without an embedding that were placed via their TF-IDF neighbors */
  imputed: number
}

const LSA_RANK = 96
const PCA_DIMS = 128
const N_NEIGHBORS = 15
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
 * Topic map of short texts:
 * features (given embeddings → PCA, or TF-IDF → randomized SVD/LSA) → kNN
 * graph → spherical k-means on kNN-smoothed vectors → outlier refinement →
 * c-TF-IDF labels → 3D UMAP layout. Deterministic for a given seed; yields to
 * the event loop every ~20 ms.
 */
export async function buildSemanticMap(
  texts: string[],
  options: SemanticOptions = {}
): Promise<SemanticResult> {
  const seed = options.seed ?? 42
  const tuning = { ...DEFAULT_TUNING, ...options.tuning }
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
  let imputed = 0
  const unclustered = (): SemanticResult => {
    timings.total = performance.now() - started
    return {
      coords: dust(n, deriveRng(seed, 3)),
      cluster: new Int16Array(n).fill(-1),
      clusters: [],
      timings,
      imputed
    }
  }

  begin('tokenizing')
  const corpus = await buildCorpus(texts, clock, (f) => report('tokenizing', f))
  end('tokenizing')

  begin('tf-idf')
  const tfidf = buildTfIdf(corpus)
  await clock.pause()
  end('tf-idf')

  // Feature rows for usable documents: given embeddings, or LSA of TF-IDF.
  const usable: number[] = []
  let source: Float32Array
  let d: number
  let docWeight: (doc: number) => number
  const { dim } = options
  if (options.vectors && dim) {
    // Tweets whose embedding failed borrow their TF-IDF neighbors' vectors.
    const filled = await imputeFromText(
      tfidf.matrix,
      options.vectors,
      dim,
      clock
    )
    const { vectors } = filled
    imputed = filled.imputed
    for (let i = 0; i < n; i++) {
      let norm = 0
      for (let t = 0; t < dim; t++) norm += vectors[i * dim + t]! ** 2
      if (norm > 0.5) usable.push(i)
      if ((i & 1023) === 0 && clock.due()) await clock.pause()
    }
    source = vectors
    d = dim
    docWeight = (doc) => options.weights?.[doc] ?? 1
  } else {
    if (tfidf.matrix.indices.length === 0) return unclustered()
    begin('svd')
    const embedding = await lsa(tfidf.matrix, {
      rank: LSA_RANK,
      rng: deriveRng(seed, 1),
      clock,
      onProgress: (f) => report('svd', f)
    })
    end('svd')
    for (let i = 0; i < n; i++)
      if (embedding.captured[i]! > 1e-6) usable.push(i)
    source = embedding.vectors
    d = embedding.dims
    // Docs the LSA subspace barely captures (mostly rare terms) have
    // unreliable directions; weight by captured energy so they neither seed
    // nor drag centroids.
    docWeight = (doc) =>
      (options.weights?.[doc] ?? 1) * embedding.captured[doc]! ** 2
  }
  const m = usable.length
  if (m === 0) return unclustered()

  // Identical vectors are processed once.
  const X = new Float32Array(m * d)
  for (const [i, src] of usable.entries()) {
    X.set(source.subarray(src * d, (src + 1) * d), i * d)
    if ((i & 4095) === 0 && clock.due()) await clock.pause()
  }
  const { unique, groupOf } = await groupDuplicates(X, m, d, clock)
  const mu = unique.length
  let Xu: Float32Array = new Float32Array(mu * d)
  unique.forEach((src, u) => Xu.set(X.subarray(src * d, (src + 1) * d), u * d))
  const weightU = new Float32Array(mu)
  const multiplicity = new Int32Array(mu)
  usable.forEach((src, i) => {
    const u = groupOf[i]!
    weightU[u]! += docWeight(src)
    multiplicity[u]!++
  })

  if (d > PCA_DIMS && mu > PCA_DIMS) {
    begin('reducing')
    Xu = await pcaProject(Xu, mu, d, PCA_DIMS, deriveRng(seed, 5), clock)
    d = PCA_DIMS
    end('reducing')
  }

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
  const smoothed =
    knn && tuning.smoothing > 0
      ? await smoothByNeighbors(Xu, mu, d, knn, tuning.smoothing, clock)
      : Xu
  const km = await sphericalKMeans(smoothed, mu, d, {
    k: options.k ?? defaultK(m),
    rng: deriveRng(seed, 2),
    clock,
    weights: weightU,
    multiplicity,
    onProgress: (f) => report('clustering', 0.9 * f)
  })
  const refined = await refineClusters(
    Xu,
    mu,
    d,
    km.assignment,
    km.k,
    knn,
    {
      minAgreement: tuning.minAgreement,
      zCut: tuning.zCut,
      minClusterSize: Math.max(10, Math.ceil(0.002 * m)),
      multiplicity,
      weights: weightU
    },
    clock
  )
  if (refined.k === 0) return unclustered()
  const cluster = new Int16Array(n).fill(-1)
  usable.forEach((src, i) => (cluster[src] = refined.labels[groupOf[i]!]!))
  end('clustering')

  begin('labeling')
  // Label from each cluster's core: docs close to the centroid dominate.
  const labelWeights = new Float32Array(n)
  usable.forEach((src, i) => {
    const sim = Math.max(0, refined.similarity[groupOf[i]!]!)
    labelWeights[src] = (options.weights?.[src] ?? 1) * sim ** LABEL_FOCUS
  })
  const labels = labelClusters(tfidf.matrix, tfidf.vocab, cluster, refined.k, {
    weights: labelWeights
  })
  end('labeling')

  begin('projecting')
  const layoutRng = deriveRng(seed, 3)
  const anchors = clusterAnchors(refined.centroids, refined.k, d, layoutRng)
  const unitCoords = await layout3d(knn, mu, refined.nearest, anchors, {
    labels: refined.labels,
    rng: layoutRng,
    clock,
    onProgress: (f) => report('projecting', f)
  })
  const docCoords = expandDuplicates(unitCoords, unique, groupOf, layoutRng)
  normalizeCoords(docCoords, m)

  // Docs with nothing usable become "dust" spread through the unit ball.
  const coords = dust(n, layoutRng)
  usable.forEach((src, i) =>
    coords.set(docCoords.subarray(i * 3, i * 3 + 3), src * 3)
  )

  const sums = new Float64Array(refined.k * 3)
  for (let i = 0; i < m; i++) {
    const c = refined.labels[groupOf[i]!]!
    if (c < 0) continue
    for (let t = 0; t < 3; t++) sums[c * 3 + t]! += docCoords[i * 3 + t]!
  }
  const clusters = labels.map((info, id) => {
    const size = refined.sizes[id]!
    const centroid: [number, number, number] = [
      sums[id * 3]! / size,
      sums[id * 3 + 1]! / size,
      sums[id * 3 + 2]! / size
    ]
    return { id, label: info.label, terms: info.terms, size, centroid }
  })
  end('projecting')

  timings.total = performance.now() - started
  return { coords, cluster, clusters, timings, imputed }
}
