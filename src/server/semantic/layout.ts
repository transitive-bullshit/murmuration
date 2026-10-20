import type { Knn } from './knn'
import { symmetricEigen } from './linalg'
import { gaussian, type Rng } from './random'
import type { Clock } from './scheduler'
import { optimizeUmap } from './umap'

export interface LayoutOptions {
  rng: Rng
  clock: Clock
  /** scale of kNN edges between different clusters (1 = unsupervised UMAP) */
  crossClusterWeight?: number
  minDist?: number
  spread?: number
  nEpochs?: number
  onProgress?: (fraction: number) => void
}

const DIMS = 3
// UMAP's usual coordinate scale (umap-learn initializes into roughly ±10).
const INIT_RADIUS = 10

/**
 * Place cluster anchors in 3D so that similar topics start near each other:
 * classical MDS of the centroids, refined by minimizing Sammon-style stress
 * against their cosine distances (classical MDS alone crowds most of ~30
 * near-orthogonal topics into the middle).
 */
export function clusterAnchors(
  centroids: Float64Array,
  k: number,
  d: number,
  rng: Rng
): Float64Array {
  const anchors = new Float64Array(k * DIMS)
  if (k < 2) return anchors

  const target = new Float64Array(k * k)
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      let s = 0
      for (let t = 0; t < d; t++)
        s += centroids[i * d + t]! * centroids[j * d + t]!
      target[i * k + j] = Math.sqrt(Math.max(0, 2 - 2 * s))
    }
  }

  // Classical MDS: Gram matrix of the centered centroids.
  const mean = new Float64Array(d)
  for (let i = 0; i < k; i++)
    for (let t = 0; t < d; t++) mean[t]! += centroids[i * d + t]! / k
  const G = new Float64Array(k * k)
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0
      for (let t = 0; t < d; t++)
        s +=
          (centroids[i * d + t]! - mean[t]!) *
          (centroids[j * d + t]! - mean[t]!)
      G[i * k + j] = G[j * k + i] = s
    }
  }
  const { values, vectors } = symmetricEigen(G, k)
  for (let i = 0; i < k; i++) {
    for (let c = 0; c < DIMS && c < k; c++) {
      anchors[i * DIMS + c] =
        vectors[i * k + c]! * Math.sqrt(Math.max(values[c]!, 0)) +
        1e-3 * gaussian(rng)
    }
  }

  // Stress refinement (gradient descent, weights 1/t² emphasize near pairs).
  // Targets are floored and steps clipped so near-identical centroids can't
  // blow the gradient up; if anything still goes non-finite, keep the MDS
  // initialization.
  const initial = Float64Array.from(anchors)
  const grad = new Float64Array(k * DIMS)
  for (let iter = 0; iter < 400; iter++) {
    grad.fill(0)
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const t = Math.max(target[i * k + j]!, 0.05)
        let dist = 0
        for (let c = 0; c < DIMS; c++)
          dist += (anchors[i * DIMS + c]! - anchors[j * DIMS + c]!) ** 2
        dist = Math.max(Math.sqrt(dist), 1e-6)
        const f = (dist - t) / (t * t * dist)
        for (let c = 0; c < DIMS; c++) {
          const g = f * (anchors[i * DIMS + c]! - anchors[j * DIMS + c]!)
          grad[i * DIMS + c]! += g
          grad[j * DIMS + c]! -= g
        }
      }
    }
    const lr = (0.5 / k) * (1 - iter / 400) + 0.01 / k
    let gmax = 0
    for (let p = 0; p < k * DIMS; p++) gmax = Math.max(gmax, Math.abs(grad[p]!))
    const clip = lr * gmax > 0.05 ? 0.05 / (lr * gmax) : 1
    for (let p = 0; p < k * DIMS; p++) anchors[p]! -= lr * clip * grad[p]!
  }
  if (!anchors.every(Number.isFinite)) anchors.set(initial)

  // Center and scale to the UMAP init radius.
  let maxRadius = 0
  const center = [0, 0, 0]
  for (let i = 0; i < k; i++)
    for (let c = 0; c < DIMS; c++) center[c]! += anchors[i * DIMS + c]! / k
  for (let i = 0; i < k; i++) {
    let r = 0
    for (let c = 0; c < DIMS; c++) {
      anchors[i * DIMS + c]! -= center[c]!
      r += anchors[i * DIMS + c]! ** 2
    }
    maxRadius = Math.max(maxRadius, Math.sqrt(r))
  }
  const scale = maxRadius > 0 ? INIT_RADIUS / maxRadius : 0
  for (let p = 0; p < k * DIMS; p++) anchors[p]! *= scale
  return anchors
}

/**
 * 3D UMAP layout of `m` unique rows given their kNN graph. Each point starts
 * at its cluster's anchor plus Gaussian jitter, so clusters begin compact and
 * semantically arranged; UMAP then refines local structure.
 */
export async function layout3d(
  knn: Knn | undefined,
  m: number,
  assignment: Int32Array,
  anchors: Float64Array,
  options: LayoutOptions
): Promise<Float32Array> {
  const { rng, clock } = options
  const coords = new Float32Array(m * DIMS)
  for (let i = 0; i < m; i++) {
    const c = assignment[i]!
    for (let t = 0; t < DIMS; t++)
      coords[i * DIMS + t] = anchors[c * DIMS + t]! + gaussian(rng)
  }
  if (!knn || knn.k < 2) return coords
  await optimizeUmap(knn, m, coords, {
    dims: DIMS,
    nEpochs: options.nEpochs ?? (m > 10000 ? 200 : 500),
    minDist: options.minDist ?? 0.1,
    spread: options.spread ?? 1,
    labels: assignment,
    crossClusterWeight: options.crossClusterWeight ?? 0.1,
    rng,
    clock,
    onProgress: options.onProgress
  })
  return coords
}

/** Copy unique-row coordinates to every duplicate, scattered in a small ball. */
export function expandDuplicates(
  unitCoords: Float32Array,
  unique: Int32Array,
  groupOf: Int32Array,
  rng: Rng
): Float32Array {
  const m = groupOf.length
  const groupSize = new Int32Array(unique.length)
  for (let i = 0; i < m; i++) groupSize[groupOf[i]!]!++
  const coords = new Float32Array(m * DIMS)
  for (let i = 0; i < m; i++) {
    const u = groupOf[i]!
    const spread = unique[u] === i ? 0 : 0.02 * Math.cbrt(groupSize[u]!)
    for (let t = 0; t < DIMS; t++)
      coords[i * DIMS + t] = unitCoords[u * DIMS + t]! + spread * gaussian(rng)
  }
  return coords
}

/** Center on the mean and scale so the 98th-percentile radius is 1. */
export function normalizeCoords(coords: Float32Array, m: number): void {
  if (m === 0) return
  const center = [0, 0, 0]
  for (let i = 0; i < m; i++)
    for (let c = 0; c < DIMS; c++) center[c]! += coords[i * DIMS + c]! / m
  const radii = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    let r = 0
    for (let c = 0; c < DIMS; c++) {
      coords[i * DIMS + c]! -= center[c]!
      r += coords[i * DIMS + c]! ** 2
    }
    radii[i] = Math.sqrt(r)
  }
  radii.sort()
  const p98 = radii[Math.min(m - 1, Math.floor(0.98 * (m - 1)))]!
  const scale = p98 > 0 ? 1 / p98 : 1
  for (let p = 0; p < m * DIMS; p++) coords[p]! *= scale
}
