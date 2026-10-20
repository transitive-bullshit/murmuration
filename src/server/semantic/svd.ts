import { gram, orthonormalize, symmetricEigen } from './linalg'
import { gaussian, type Rng } from './random'
import type { Clock } from './scheduler'
import { multiply, multiplyTransposed, type Csr } from './sparse'

export interface SvdOptions {
  rank: number
  oversample?: number
  powerIterations?: number
  rng: Rng
  clock: Clock
  onProgress?: (fraction: number) => void
}

export interface Lsa {
  /** rows × dims, each non-empty row L2-normalized */
  vectors: Float32Array
  /** per row: norm of the projection before normalization, i.e. how much of the (unit) TF-IDF row the subspace captures */
  captured: Float32Array
  dims: number
  singularValues: Float64Array
}

/**
 * Truncated randomized SVD (Halko, Martinsson & Tropp 2011) of a sparse
 * matrix using only sparse × dense products, returning L2-normalized LSA
 * document vectors U·Σ.
 */
export async function lsa(A: Csr, options: SvdOptions): Promise<Lsa> {
  const { rng, clock } = options
  const progress = options.onProgress ?? (() => {})
  const maxRank = Math.max(1, Math.min(A.rows, A.cols))
  const l = Math.min(maxRank, options.rank + (options.oversample ?? 10))
  const r = Math.min(options.rank, l)
  const q = options.powerIterations ?? 2
  const totalSteps = 4 + 2 * q
  let step = 0
  const tick = () => progress(++step / totalSteps)

  const omega = new Float64Array(A.cols * l)
  for (let i = 0; i < omega.length; i++) {
    omega[i] = gaussian(rng)
    if ((i & 65535) === 0 && clock.due()) await clock.pause()
  }

  // Range finder with power iterations, re-orthonormalizing after every
  // product so the block stays well conditioned.
  let Y = await multiply(A, omega, l, clock)
  await orthonormalize(Y, A.rows, l, 1, clock)
  tick()
  for (let it = 0; it < q; it++) {
    const Z = await multiplyTransposed(A, Y, l, clock)
    await orthonormalize(Z, A.cols, l, 1, clock)
    tick()
    Y = await multiply(A, Z, l, clock)
    await orthonormalize(Y, A.rows, l, it === q - 1 ? 2 : 1, clock)
    tick()
  }
  const Q = Y

  // B = Qᵀ·A is l × cols; its left singular vectors come from B·Bᵀ = MᵀM with M = Aᵀ·Q.
  const M = await multiplyTransposed(A, Q, l, clock)
  tick()
  const C = await gram(M, A.cols, l, clock)
  const { values, vectors: W } = symmetricEigen(C, l)
  tick()

  const singularValues = new Float64Array(r)
  for (let j = 0; j < r; j++)
    singularValues[j] = Math.sqrt(Math.max(values[j]!, 0))

  // Project: U·Σ = Q·W[:, :r]·Σ, then L2-normalize each row.
  const P = new Float64Array(l * r)
  for (let a = 0; a < l; a++)
    for (let j = 0; j < r; j++)
      P[a * r + j] = W[a * l + j]! * singularValues[j]!
  const out = new Float32Array(A.rows * r)
  const captured = new Float32Array(A.rows)
  const row = new Float64Array(r)
  for (let i = 0; i < A.rows; i++) {
    row.fill(0)
    const qo = i * l
    for (let a = 0; a < l; a++) {
      const qa = Q[qo + a]!
      if (qa === 0) continue
      const po = a * r
      for (let j = 0; j < r; j++) row[j]! += qa * P[po + j]!
    }
    let norm = 0
    for (let j = 0; j < r; j++) norm += row[j]! * row[j]!
    // Empty documents stay all-zero; tiny norms are numerical noise.
    captured[i] = Math.sqrt(norm)
    const inv = norm > 1e-20 ? 1 / Math.sqrt(norm) : 0
    for (let j = 0; j < r; j++) out[i * r + j] = row[j]! * inv
    if ((i & 255) === 0 && clock.due()) await clock.pause()
  }
  tick()
  return { vectors: out, captured, dims: r, singularValues }
}
