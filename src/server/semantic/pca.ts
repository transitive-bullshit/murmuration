import { orthonormalize } from './linalg'
import { gaussian, type Rng } from './random'
import type { Clock } from './scheduler'

const SAMPLE = 6000
const ITERATIONS = 12

/**
 * Center rows, project them onto (an orthonormal basis of) the top-`k`
 * principal subspace and L2-normalize. The subspace comes from block power
 * iteration on the covariance of a row sample; dot products don't depend on
 * the basis chosen within it, so no eigen-rotation is needed. Centering also
 * removes the shared "everything is similar" direction of sentence
 * embeddings, which sharpens cosine neighborhoods.
 */
export async function pcaProject(
  X: Float32Array,
  m: number,
  d: number,
  k: number,
  rng: Rng,
  clock: Clock
): Promise<Float32Array> {
  const mean = new Float64Array(d)
  for (let i = 0; i < m; i++)
    for (let t = 0; t < d; t++) mean[t]! += X[i * d + t]!
  for (let t = 0; t < d; t++) mean[t]! /= Math.max(1, m)

  // Covariance (upper triangle, then mirrored) of an evenly spread sample.
  const s = Math.min(m, SAMPLE)
  const C = new Float64Array(d * d)
  const row = new Float64Array(d)
  for (let r = 0; r < s; r++) {
    const i = Math.floor((r * m) / s)
    for (let t = 0; t < d; t++) row[t] = X[i * d + t]! - mean[t]!
    for (let a = 0; a < d; a++) {
      const va = row[a]!
      const o = a * d
      for (let b = a; b < d; b++) C[o + b]! += va * row[b]!
    }
    if ((r & 63) === 0 && clock.due()) await clock.pause()
  }
  for (let a = 0; a < d; a++)
    for (let b = 0; b < a; b++) C[a * d + b] = C[b * d + a]!

  // Block power iteration: Q ← orth(C·Q), Q is d × k row-major.
  let Q = new Float64Array(d * k)
  for (let p = 0; p < Q.length; p++) Q[p] = gaussian(rng)
  await orthonormalize(Q, d, k, 2, clock)
  for (let it = 0; it < ITERATIONS; it++) {
    const Z = new Float64Array(d * k)
    for (let a = 0; a < d; a++) {
      for (let b = 0; b < d; b++) {
        const c = C[a * d + b]!
        if (c === 0) continue
        const zo = a * k
        const qo = b * k
        for (let j = 0; j < k; j++) Z[zo + j]! += c * Q[qo + j]!
      }
      if (clock.due()) await clock.pause()
    }
    await orthonormalize(Z, d, k, it === ITERATIONS - 1 ? 2 : 1, clock)
    Q = Z
  }

  const out = new Float32Array(m * k)
  const acc = new Float64Array(k)
  for (let i = 0; i < m; i++) {
    acc.fill(0)
    for (let t = 0; t < d; t++) {
      const v = X[i * d + t]! - mean[t]!
      const qo = t * k
      for (let j = 0; j < k; j++) acc[j]! += v * Q[qo + j]!
    }
    let norm = 0
    for (let j = 0; j < k; j++) norm += acc[j]! * acc[j]!
    const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0
    for (let j = 0; j < k; j++) out[i * k + j] = acc[j]! * inv
    if ((i & 255) === 0 && clock.due()) await clock.pause()
  }
  return out
}
