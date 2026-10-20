import type { Knn } from './knn'
import type { Rng } from './random'
import type { Clock } from './scheduler'

// A typed-array port of UMAP's fuzzy simplicial set + SGD layout
// (McInnes et al. 2018), following the reference umap-learn implementation.
// umap-js 1.4 was measured on the same 43k-point kNN graph: `initializeFit`
// (Map-backed sparse matrices) blocks the event loop for ~16 s in one call
// and each `step()` takes ~110 ms; this version builds the graph in well
// under a second, runs ~60 ms/epoch and yields cooperatively.

export interface UmapOptions {
  dims: number
  nEpochs: number
  minDist?: number
  spread?: number
  negativeSampleRate?: number
  learningRate?: number
  repulsionStrength?: number
  /**
   * Optional cluster id per point: edges between different clusters are
   * scaled by `crossClusterWeight` (like umap-learn's categorical
   * supervision), so clusters read as contiguous, separated regions.
   */
  labels?: Int32Array
  crossClusterWeight?: number
  rng: Rng
  clock: Clock
  onProgress?: (fraction: number) => void
}

/** Fit 1 / (1 + a·x^(2b)) to UMAP's target membership curve (Levenberg-Marquardt). */
export function findABParams(
  spread: number,
  minDist: number
): { a: number; b: number } {
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < 300; i++) {
    const x = (i / 299) * spread * 3
    xs.push(x)
    ys.push(x < minDist ? 1 : Math.exp(-(x - minDist) / spread))
  }
  const loss = (a: number, b: number) => {
    let s = 0
    for (let i = 0; i < xs.length; i++)
      s += (1 / (1 + a * xs[i]! ** (2 * b)) - ys[i]!) ** 2
    return s
  }
  let a = 1
  let b = 1
  let lambda = 1e-3
  let current = loss(a, b)
  for (let iter = 0; iter < 200; iter++) {
    // Normal equations JᵀJ·δ = −Jᵀr for the two parameters.
    let jaa = 0
    let jab = 0
    let jbb = 0
    let ga = 0
    let gb = 0
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!
      if (x <= 0) continue
      const u = x ** (2 * b)
      const den = 1 + a * u
      const r = 1 / den - ys[i]!
      const da = -u / (den * den)
      const db = (-a * u * 2 * Math.log(x)) / (den * den)
      jaa += da * da
      jab += da * db
      jbb += db * db
      ga += da * r
      gb += db * r
    }
    const maa = jaa * (1 + lambda)
    const mbb = jbb * (1 + lambda)
    const det = maa * mbb - jab * jab
    if (Math.abs(det) < 1e-300) break
    const stepA = (-ga * mbb + gb * jab) / det
    const stepB = (-gb * maa + ga * jab) / det
    const na = a + stepA
    const nb = b + stepB
    const next = na > 0 && nb > 0 ? loss(na, nb) : Infinity
    if (next < current) {
      const done = current - next < 1e-14
      a = na
      b = nb
      current = next
      lambda *= 0.3
      if (done) break
    } else {
      lambda *= 10
      if (lambda > 1e12) break
    }
  }
  return { a, b }
}

interface Graph {
  head: Int32Array
  tail: Int32Array
  weight: Float32Array
}

/** Fuzzy union of the local fuzzy simplicial sets: w = a + aᵀ − a∘aᵀ. */
async function fuzzySimplicialSet(
  knn: Knn,
  m: number,
  clock: Clock
): Promise<Graph> {
  const { k, indices, distances } = knn
  const target = Math.log2(k + 1)
  const sigma = new Float64Array(m)
  const rho = new Float64Array(m)
  let globalMean = 0
  let finiteCount = 0
  for (let p = 0; p < m * k; p++) {
    if (Number.isFinite(distances[p]!)) {
      globalMean += distances[p]!
      finiteCount++
    }
  }
  globalMean /= Math.max(1, finiteCount)

  for (let i = 0; i < m; i++) {
    const o = i * k
    let r = 0
    let mean = 0
    let count = 0
    for (let t = 0; t < k; t++) {
      const dist = distances[o + t]!
      if (!Number.isFinite(dist)) continue
      if (r === 0 && dist > 0) r = dist
      mean += dist
      count++
    }
    mean /= Math.max(1, count)
    rho[i] = r
    let lo = 0
    let hi = Infinity
    let mid = 1
    for (let iter = 0; iter < 64; iter++) {
      let psum = 0
      for (let t = 0; t < k; t++) {
        const dist = distances[o + t]!
        if (!Number.isFinite(dist)) continue
        const x = dist - r
        psum += x > 0 ? Math.exp(-x / mid) : 1
      }
      if (Math.abs(psum - target) < 1e-5) break
      if (psum > target) {
        hi = mid
        mid = (lo + hi) / 2
      } else {
        lo = mid
        mid = hi === Infinity ? mid * 2 : (lo + hi) / 2
      }
    }
    sigma[i] = Math.max(mid, 1e-3 * (r > 0 ? mean : globalMean))
    if ((i & 255) === 0 && clock.due()) await clock.pause()
  }

  const membership = new Float32Array(m * k)
  for (let i = 0; i < m; i++) {
    for (let t = 0; t < k; t++) {
      const p = i * k + t
      const j = indices[p]!
      const dist = distances[p]!
      if (j < 0 || j === i || !Number.isFinite(dist)) continue
      const x = dist - rho[i]!
      membership[p] = x <= 0 ? 1 : Math.exp(-x / sigma[i]!)
    }
  }

  const head = new Int32Array(2 * m * k)
  const tail = new Int32Array(2 * m * k)
  const weight = new Float32Array(2 * m * k)
  let e = 0
  for (let i = 0; i < m; i++) {
    for (let t = 0; t < k; t++) {
      const p = i * k + t
      const j = indices[p]!
      const w = membership[p]!
      if (j < 0 || w <= 0) continue
      let back = -1
      for (let s = 0; s < k; s++) {
        if (indices[j * k + s] === i) {
          back = j * k + s
          break
        }
      }
      if (back >= 0 && membership[back]! > 0) {
        // Mutual neighbors: j emits the mirrored edge itself.
        const wb = membership[back]!
        head[e] = i
        tail[e] = j
        weight[e++] = w + wb - w * wb
      } else {
        head[e] = i
        tail[e] = j
        weight[e++] = w
        head[e] = j
        tail[e] = i
        weight[e++] = w
      }
    }
    if ((i & 1023) === 0 && clock.due()) await clock.pause()
  }
  return {
    head: head.slice(0, e),
    tail: tail.slice(0, e),
    weight: weight.slice(0, e)
  }
}

/** Optimize `embedding` (m × dims, modified in place) against the kNN graph. */
export async function optimizeUmap(
  knn: Knn,
  m: number,
  embedding: Float32Array,
  options: UmapOptions
): Promise<void> {
  const { dims, nEpochs, clock } = options
  const progress = options.onProgress ?? (() => {})
  const { a, b } = findABParams(options.spread ?? 1, options.minDist ?? 0.1)
  const negativeRate = options.negativeSampleRate ?? 5
  const initialAlpha = options.learningRate ?? 1
  const gamma = options.repulsionStrength ?? 1

  const graph = await fuzzySimplicialSet(knn, m, clock)
  const { labels } = options
  if (labels) {
    const cross = options.crossClusterWeight ?? 0.1
    for (let e = 0; e < graph.weight.length; e++) {
      if (labels[graph.head[e]!] !== labels[graph.tail[e]!])
        graph.weight[e]! *= cross
    }
  }
  let maxWeight = 0
  for (const w of graph.weight) maxWeight = Math.max(maxWeight, w)
  if (maxWeight <= 0) return
  // Drop edges too weak to be sampled even once; sample the rest every
  // maxWeight / weight epochs.
  const total = graph.weight.length
  const head = new Int32Array(total)
  const tail = new Int32Array(total)
  const epochsPerSample = new Float64Array(total)
  let E = 0
  for (let src = 0; src < total; src++) {
    const w = graph.weight[src]!
    if (w < maxWeight / nEpochs) continue
    head[E] = graph.head[src]!
    tail[E] = graph.tail[src]!
    epochsPerSample[E++] = maxWeight / w
  }
  const epochOfNextSample = epochsPerSample.slice(0, E)
  const epochsPerNegative = epochOfNextSample.map((v) => v / negativeRate)
  const epochOfNextNegative = epochsPerNegative.slice()

  let seed = Math.floor(options.rng() * 0x7fffffff) | 1
  // Optimize in float64: avoids float32 conversions on every access.
  const Y = Float64Array.from(embedding)
  const clip = (v: number) => (v > 4 ? 4 : v < -4 ? -4 : v)

  const runEdges = (from: number, to: number, epoch: number, alpha: number) => {
    let s = seed
    for (let e = from; e < to; e++) {
      if (epochOfNextSample[e]! > epoch) continue
      const j = head[e]!
      const k = tail[e]!
      const jo = j * dims
      const ko = k * dims
      let d2 = 0
      for (let t = 0; t < dims; t++) {
        const diff = Y[jo + t]! - Y[ko + t]!
        d2 += diff * diff
      }
      if (d2 > 0) {
        const pb1 = Math.pow(d2, b - 1)
        const coeff = (-2 * a * b * pb1) / (a * pb1 * d2 + 1)
        for (let t = 0; t < dims; t++) {
          const g = clip(coeff * (Y[jo + t]! - Y[ko + t]!)) * alpha
          Y[jo + t]! += g
          Y[ko + t]! -= g
        }
      }
      epochOfNextSample[e]! += epochsPerSample[e]!

      const nNeg = Math.floor(
        (epoch - epochOfNextNegative[e]!) / epochsPerNegative[e]!
      )
      for (let p = 0; p < nNeg; p++) {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        const n = (s & 0x7fffffff) % m
        if (n === j) continue
        const no = n * dims
        let nd2 = 0
        for (let t = 0; t < dims; t++) {
          const diff = Y[jo + t]! - Y[no + t]!
          nd2 += diff * diff
        }
        if (nd2 <= 0) continue
        const coeff =
          (2 * gamma * b) / ((0.001 + nd2) * (a * Math.pow(nd2, b) + 1))
        for (let t = 0; t < dims; t++)
          Y[jo + t]! += clip(coeff * (Y[jo + t]! - Y[no + t]!)) * alpha
      }
      epochOfNextNegative[e]! += nNeg * epochsPerNegative[e]!
    }
    seed = s
  }

  const chunk = 1 << 15
  for (let epoch = 0; epoch < nEpochs; epoch++) {
    const alpha = initialAlpha * (1 - epoch / nEpochs)
    for (let from = 0; from < E; from += chunk) {
      runEdges(from, Math.min(E, from + chunk), epoch, alpha)
      if (clock.due()) {
        progress((epoch + from / E) / nEpochs)
        await clock.pause()
      }
    }
  }
  embedding.set(Y)
  progress(1)
}
