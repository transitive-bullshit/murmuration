import type { Clock } from './scheduler'
import { tokenRuns } from './tokenize'

/** Unique terms per document with raw counts, before vocabulary filtering. */
export interface Corpus {
  nDocs: number
  /** display string per term id (bigrams are "a b") */
  terms: string[]
  /** document frequency per term id */
  df: Int32Array
  /** CSR-style per-document unique term ids and their counts */
  docPtr: Int32Array
  docTerms: Int32Array
  docCounts: Uint16Array
  /** 1 when the document produced at least one kept token */
  hasTokens: Uint8Array
}

// Plurals that must never be folded into a shorter "singular".
const NO_FOLD = new Set([
  'ios',
  'aws',
  'macos',
  'kubernetes',
  'saas',
  'paas',
  'news',
  'chaos',
  'canvas',
  'bias',
  'alias',
  'atlas',
  'devops',
  'mlops',
  'jobs'
])

class IntBuffer {
  data = new Int32Array(1 << 16)
  length = 0
  push(value: number) {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = value
  }
}

/** Map plural surface forms onto their singular when both occur ("llms" → "llm"). */
function foldPlurals(words: string[], counts: number[]): Int32Array {
  const index = new Map<string, number>()
  words.forEach((w, i) => index.set(w, i))
  const canon = new Int32Array(words.length)
  for (let i = 0; i < words.length; i++) {
    canon[i] = i
    const w = words[i]!
    if (
      w.length < 4 ||
      NO_FOLD.has(w) ||
      !w.endsWith('s') ||
      /(?:ss|us|is)$/u.test(w)
    )
      continue
    const candidates = w.endsWith('ies')
      ? [`${w.slice(0, -3)}y`, w.slice(0, -1)]
      : [w.slice(0, -1)]
    if (/(?:ses|xes|ches|shes|zes)$/u.test(w)) candidates.push(w.slice(0, -2))
    for (const base of candidates) {
      const j = index.get(base)
      if (j !== undefined && base.length >= 3) {
        canon[i] = j
        break
      }
    }
  }
  // Resolve to the most frequent surface form within each folded group.
  const best = new Map<number, number>()
  for (let i = 0; i < words.length; i++) {
    const root = canon[i]!
    const cur = best.get(root)
    if (cur === undefined || counts[i]! > counts[cur]!) best.set(root, i)
  }
  for (let i = 0; i < words.length; i++) canon[i] = best.get(canon[i]!)!
  return canon
}

export async function buildCorpus(
  texts: string[],
  clock: Clock,
  onProgress: (fraction: number) => void
): Promise<Corpus> {
  const n = texts.length
  const words: string[] = []
  const wordCounts: number[] = []
  const wordIndex = new Map<string, number>()
  // Flat token stream: word ids, -1 ends a run, -2 ends a document.
  const stream = new IntBuffer()
  const hasTokens = new Uint8Array(n)

  for (let d = 0; d < n; d++) {
    for (const run of tokenRuns(texts[d] ?? '')) {
      for (const token of run) {
        let id = wordIndex.get(token)
        if (id === undefined) {
          id = words.length
          wordIndex.set(token, id)
          words.push(token)
          wordCounts.push(0)
        }
        wordCounts[id]!++
        stream.push(id)
        hasTokens[d] = 1
      }
      stream.push(-1)
    }
    stream.push(-2)
    if (clock.due()) {
      onProgress((0.8 * d) / n)
      await clock.pause()
    }
  }

  const canon = foldPlurals(words, wordCounts)
  // Term ids: unigrams keep their (canonical) word id, bigrams get ids after.
  const terms = words.slice()
  const bigramIndex = new Map<number, number>()
  const nWords = words.length
  const docPtr = new Int32Array(n + 1)
  const docTerms = new IntBuffer()
  const docCounts: number[] = []
  const dfList: number[] = Array.from({ length: nWords }, () => 0)

  let pos = 0
  let scratch: number[] = []
  const data = stream.data
  for (let d = 0; d < n; d++) {
    scratch = []
    let prev = -1
    for (;;) {
      const raw = data[pos++]!
      if (raw === -2) break
      if (raw === -1) {
        prev = -1
        continue
      }
      const w = canon[raw]!
      scratch.push(w)
      if (prev >= 0 && prev !== w) {
        const key = prev * nWords + w
        let id = bigramIndex.get(key)
        if (id === undefined) {
          id = terms.length
          bigramIndex.set(key, id)
          terms.push(`${terms[prev]} ${terms[w]}`)
          dfList.push(0)
        }
        scratch.push(id)
      }
      prev = w
    }
    scratch.sort((a, b) => a - b)
    for (let i = 0; i < scratch.length;) {
      let j = i
      while (j < scratch.length && scratch[j] === scratch[i]) j++
      docTerms.push(scratch[i]!)
      docCounts.push(Math.min(j - i, 65535))
      dfList[scratch[i]!]!++
      i = j
    }
    docPtr[d + 1] = docTerms.length
    if (clock.due()) {
      onProgress(0.8 + (0.2 * d) / n)
      await clock.pause()
    }
  }

  return {
    nDocs: n,
    terms,
    df: Int32Array.from(dfList),
    docPtr,
    docTerms: docTerms.data.slice(0, docTerms.length),
    docCounts: Uint16Array.from(docCounts),
    hasTokens
  }
}
