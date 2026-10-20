import type { Clock } from './scheduler'
import type { Csr } from './sparse'

const NEIGHBORS = 10
// Very common terms say little about a short text and have long postings.
const MAX_POSTINGS = 4000

/**
 * Documents with text but no embedding (their request failed) get the
 * similarity-weighted mean vector of their nearest TF-IDF neighbors that do
 * have one, so they still land among related tweets. Documents sharing no
 * terms with any embedded document keep a zero vector (unclustered).
 * Returns the input array untouched when nothing is missing.
 */
export async function imputeFromText(
  matrix: Csr,
  vectors: Float32Array,
  dim: number,
  clock: Clock
): Promise<{ vectors: Float32Array; imputed: number }> {
  const n = matrix.rows
  const hasVector = new Uint8Array(n)
  const missing: number[] = []
  for (let i = 0; i < n; i++) {
    let norm = 0
    for (let t = 0; t < dim; t++) norm += vectors[i * dim + t]! ** 2
    if (norm > 0.5) hasVector[i] = 1
    else if (matrix.indptr[i + 1]! > matrix.indptr[i]!) missing.push(i)
    if ((i & 1023) === 0 && clock.due()) await clock.pause()
  }
  if (!missing.length) return { vectors, imputed: 0 }

  // Inverted index over embedded documents.
  const postings: Array<Array<[number, number]>> = Array.from(
    { length: matrix.cols },
    () => []
  )
  for (let i = 0; i < n; i++) {
    if (!hasVector[i]) continue
    for (let p = matrix.indptr[i]!; p < matrix.indptr[i + 1]!; p++)
      postings[matrix.indices[p]!]!.push([i, matrix.data[p]!])
    if ((i & 1023) === 0 && clock.due()) await clock.pause()
  }

  const out = Float32Array.from(vectors)
  const score = new Float64Array(n)
  let imputed = 0
  for (const i of missing) {
    const touched: number[] = []
    for (let p = matrix.indptr[i]!; p < matrix.indptr[i + 1]!; p++) {
      const list = postings[matrix.indices[p]!]!
      if (list.length > MAX_POSTINGS) continue
      const w = matrix.data[p]!
      for (const [j, wj] of list) {
        if (score[j] === 0) touched.push(j)
        score[j]! += w * wj
      }
    }
    const top = touched
      .sort((a, b) => score[b]! - score[a]! || a - b)
      .slice(0, NEIGHBORS)
    const acc = new Float64Array(dim)
    for (const j of top)
      for (let t = 0; t < dim; t++) acc[t]! += score[j]! * vectors[j * dim + t]!
    for (const j of touched) score[j] = 0
    let norm = 0
    for (let t = 0; t < dim; t++) norm += acc[t]! ** 2
    if (norm > 0) {
      const inv = 1 / Math.sqrt(norm)
      for (let t = 0; t < dim; t++) out[i * dim + t] = acc[t]! * inv
      imputed++
    }
    if (clock.due()) await clock.pause()
  }
  return { vectors: out, imputed }
}
