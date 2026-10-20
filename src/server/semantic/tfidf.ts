import type { Corpus } from './corpus'
import type { Csr } from './sparse'

export interface TfIdf {
  matrix: Csr
  /** display string per column */
  vocab: string[]
  /** document frequency per column */
  df: Int32Array
}

export interface VocabOptions {
  minDf?: number
  maxDfRatio?: number
  maxVocab?: number
}

/**
 * Select the vocabulary by document frequency, then build L2-normalized
 * TF-IDF rows with sublinear tf (1 + ln tf) and smooth idf
 * (ln((1 + n) / (1 + df)) + 1, as in scikit-learn).
 */
export function buildTfIdf(corpus: Corpus, options: VocabOptions = {}): TfIdf {
  const n = corpus.nDocs
  const minDf =
    options.minDf ??
    Math.max(Math.min(3, Math.ceil(n / 50)), Math.ceil(n / 20000))
  const maxDf = Math.max(minDf, Math.floor((options.maxDfRatio ?? 0.25) * n))
  const maxVocab = options.maxVocab ?? 40000

  const candidates: number[] = []
  for (let t = 0; t < corpus.df.length; t++) {
    const df = corpus.df[t]!
    if (df >= minDf && df <= maxDf) candidates.push(t)
  }
  candidates.sort((a, b) => corpus.df[b]! - corpus.df[a]! || a - b)
  const selected = candidates.slice(0, maxVocab)

  const column = new Int32Array(corpus.terms.length).fill(-1)
  const vocab: string[] = []
  const df = new Int32Array(selected.length)
  const idf = new Float64Array(selected.length)
  selected.forEach((t, c) => {
    column[t] = c
    vocab.push(corpus.terms[t]!)
    df[c] = corpus.df[t]!
    idf[c] = Math.log((1 + n) / (1 + df[c]!)) + 1
  })

  const indptr = new Int32Array(n + 1)
  let nnz = 0
  for (let d = 0; d < n; d++) {
    for (let p = corpus.docPtr[d]!; p < corpus.docPtr[d + 1]!; p++) {
      if (column[corpus.docTerms[p]!]! >= 0) nnz++
    }
    indptr[d + 1] = nnz
  }

  const indices = new Int32Array(nnz)
  const data = new Float32Array(nnz)
  let q = 0
  for (let d = 0; d < n; d++) {
    const start = q
    let norm = 0
    for (let p = corpus.docPtr[d]!; p < corpus.docPtr[d + 1]!; p++) {
      const c = column[corpus.docTerms[p]!]!
      if (c < 0) continue
      const w = (1 + Math.log(corpus.docCounts[p]!)) * idf[c]!
      indices[q] = c
      data[q++] = w
      norm += w * w
    }
    if (norm > 0) {
      const inv = 1 / Math.sqrt(norm)
      for (let p = start; p < q; p++) data[p]! *= inv
    }
  }

  return {
    matrix: { rows: n, cols: selected.length, indptr, indices, data },
    vocab,
    df
  }
}
