import type { Clock } from './scheduler'

/**
 * Eigen-decomposition of a small dense symmetric matrix (row-major n×n) by
 * cyclic Jacobi rotations. Returns eigenvalues in descending order and the
 * matching eigenvectors as columns of a row-major n×n matrix.
 */
export function symmetricEigen(
  matrix: Float64Array,
  n: number
): { values: Float64Array; vectors: Float64Array } {
  const a = Float64Array.from(matrix)
  const v = new Float64Array(n * n)
  for (let i = 0; i < n; i++) v[i * n + i] = 1

  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0
    let diag = 0
    for (let i = 0; i < n; i++) {
      diag += a[i * n + i]! ** 2
      for (let j = i + 1; j < n; j++) off += a[i * n + j]! ** 2
    }
    if (off <= 1e-24 * Math.max(diag, 1e-300)) break

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]!
        if (Math.abs(apq) < 1e-300) continue
        const theta = (a[q * n + q]! - a[p * n + p]!) / (2 * apq)
        const t =
          Math.sign(theta || 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p]!
          const akq = a[k * n + q]!
          a[k * n + p] = c * akp - s * akq
          a[k * n + q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k]!
          const aqk = a[q * n + k]!
          a[p * n + k] = c * apk - s * aqk
          a[q * n + k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p]!
          const vkq = v[k * n + q]!
          v[k * n + p] = c * vkp - s * vkq
          v[k * n + q] = s * vkp + c * vkq
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (i, j) => a[j * n + j]! - a[i * n + i]! || i - j
  )
  const values = new Float64Array(n)
  const vectors = new Float64Array(n * n)
  order.forEach((src, dst) => {
    values[dst] = a[src * n + src]!
    for (let k = 0; k < n; k++) vectors[k * n + dst] = v[k * n + src]!
  })
  return { values, vectors }
}

/** G = Yᵀ·Y for row-major Y (rows × l). */
export async function gram(
  Y: Float64Array,
  rows: number,
  l: number,
  clock: Clock
): Promise<Float64Array> {
  const G = new Float64Array(l * l)
  for (let i = 0; i < rows; i++) {
    const o = i * l
    for (let a = 0; a < l; a++) {
      const ya = Y[o + a]!
      if (ya === 0) continue
      const ga = a * l
      for (let b = a; b < l; b++) G[ga + b]! += ya * Y[o + b]!
    }
    if ((i & 255) === 0 && clock.due()) await clock.pause()
  }
  for (let a = 0; a < l; a++)
    for (let b = 0; b < a; b++) G[a * l + b] = G[b * l + a]!
  return G
}

/** Upper-triangular R with G = RᵀR; a tiny ridge keeps rank-deficient inputs finite. */
function cholesky(G: Float64Array, l: number): Float64Array {
  let maxDiag = 0
  for (let i = 0; i < l; i++) maxDiag = Math.max(maxDiag, G[i * l + i]!)
  const ridge = Math.max(maxDiag, 1e-300) * 1e-12
  const R = new Float64Array(l * l)
  for (let j = 0; j < l; j++) {
    let s = G[j * l + j]! + ridge
    for (let k = 0; k < j; k++) s -= R[k * l + j]! ** 2
    const rjj = Math.sqrt(Math.max(s, ridge))
    R[j * l + j] = rjj
    for (let i = j + 1; i < l; i++) {
      let t = G[j * l + i]!
      for (let k = 0; k < j; k++) t -= R[k * l + j]! * R[k * l + i]!
      R[j * l + i] = t / rjj
    }
  }
  return R
}

/**
 * Orthonormalize the columns of Y in place via Cholesky QR (repeated
 * `passes` times — two passes give orthogonality to machine precision for
 * the moderately conditioned blocks a randomized SVD produces).
 */
export async function orthonormalize(
  Y: Float64Array,
  rows: number,
  l: number,
  passes: number,
  clock: Clock
): Promise<void> {
  const x = new Float64Array(l)
  for (let pass = 0; pass < passes; pass++) {
    const R = cholesky(await gram(Y, rows, l, clock), l)
    // Rᵀ row-major so the substitution below reads contiguous memory.
    const Rt = new Float64Array(l * l)
    for (let a = 0; a < l; a++)
      for (let b = 0; b < l; b++) Rt[b * l + a] = R[a * l + b]!
    // Solve x·R = y for every row (forward substitution).
    for (let i = 0; i < rows; i++) {
      const o = i * l
      for (let j = 0; j < l; j++) {
        const rj = j * l
        let t = Y[o + j]!
        for (let k = 0; k < j; k++) t -= x[k]! * Rt[rj + k]!
        x[j] = t / Rt[rj + j]!
      }
      for (let j = 0; j < l; j++) Y[o + j] = x[j]!
      if ((i & 255) === 0 && clock.due()) await clock.pause()
    }
  }
}
