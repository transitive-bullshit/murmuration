import type { Clock } from './scheduler'

/** Compressed sparse row matrix. */
export interface Csr {
  rows: number
  cols: number
  indptr: Int32Array
  indices: Int32Array
  data: Float32Array
}

/** Y = A · X, with X dense row-major (A.cols × l). */
export async function multiply(
  A: Csr,
  X: Float64Array,
  l: number,
  clock: Clock
): Promise<Float64Array> {
  const Y = new Float64Array(A.rows * l)
  const { indptr, indices, data } = A
  for (let i = 0; i < A.rows; i++) {
    const yo = i * l
    for (let p = indptr[i]!; p < indptr[i + 1]!; p++) {
      const v = data[p]!
      const xo = indices[p]! * l
      for (let t = 0; t < l; t++) Y[yo + t]! += v * X[xo + t]!
    }
    if ((i & 255) === 0 && clock.due()) await clock.pause()
  }
  return Y
}

/** Z = Aᵀ · Y, with Y dense row-major (A.rows × l). */
export async function multiplyTransposed(
  A: Csr,
  Y: Float64Array,
  l: number,
  clock: Clock
): Promise<Float64Array> {
  const Z = new Float64Array(A.cols * l)
  const { indptr, indices, data } = A
  for (let i = 0; i < A.rows; i++) {
    const yo = i * l
    for (let p = indptr[i]!; p < indptr[i + 1]!; p++) {
      const v = data[p]!
      const zo = indices[p]! * l
      for (let t = 0; t < l; t++) Z[zo + t]! += v * Y[yo + t]!
    }
    if ((i & 255) === 0 && clock.due()) await clock.pause()
  }
  return Z
}
