import type { Csr } from './sparse'

export interface ClusterLabel {
  label: string
  terms: string[]
}

export interface LabelOptions {
  weights?: Float32Array
  /** number of `terms` to return per cluster */
  topTerms?: number
  /** max label length before dropping the third term */
  maxLabelLength?: number
}

const CANDIDATES = 40

/** Crude stem used only to spot near-duplicate label words (agent/agents, watch/watched). */
function stem(word: string): string {
  let w = word
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  return w
}

/**
 * Class-based TF-IDF (as in BERTopic): treat each cluster as one document,
 * score = (weighted doc count of term in cluster / cluster total) ·
 * ln(1 + average cluster total / term total across clusters).
 */
export function labelClusters(
  matrix: Csr,
  vocab: string[],
  cluster: Int16Array | Int32Array,
  k: number,
  options: LabelOptions = {}
): ClusterLabel[] {
  const V = vocab.length
  const topTerms = options.topTerms ?? 8
  const maxLabelLength = options.maxLabelLength ?? 28
  const tf = new Float64Array(k * V)
  const count = new Int32Array(k * V)
  const sizes = new Int32Array(k)

  for (let d = 0; d < matrix.rows; d++) {
    const c = cluster[d]!
    if (c < 0) continue
    sizes[c]!++
    const w = Math.max(options.weights?.[d] ?? 1, 1e-3)
    for (let p = matrix.indptr[d]!; p < matrix.indptr[d + 1]!; p++) {
      const o = c * V + matrix.indices[p]!
      tf[o]! += w
      count[o]!++
    }
  }

  const classTotal = new Float64Array(k)
  const termTotal = new Float64Array(V)
  for (let c = 0; c < k; c++) {
    for (let t = 0; t < V; t++) {
      const v = tf[c * V + t]!
      classTotal[c]! += v
      termTotal[t]! += v
    }
  }
  let avg = 0
  let grand = 0
  for (let c = 0; c < k; c++) {
    avg += classTotal[c]! / k
    grand += classTotal[c]!
  }

  const labels: ClusterLabel[] = []
  for (let c = 0; c < k; c++) {
    const scored: Array<{ term: number; score: number }> = []
    const minCount = Math.max(2, Math.ceil(0.01 * sizes[c]!))
    // Prefer terms clearly over-represented in the cluster (lift = P(t|c) / P(t));
    // relax the filters only when a cluster has nothing that qualifies.
    const passes = [
      [minCount, 2],
      [minCount, 0],
      [1, 0]
    ] as const
    for (const [pass, [minDocs, minLift]] of passes.entries()) {
      if (!classTotal[c]) break
      scored.length = 0
      for (let t = 0; t < V; t++) {
        const o = c * V + t
        if (count[o]! < minDocs) continue
        const share = tf[o]! / classTotal[c]!
        if (share / (termTotal[t]! / grand) < minLift) continue
        scored.push({
          term: t,
          score: share * Math.log(1 + avg / termTotal[t]!)
        })
      }
      if (scored.length >= 3 || pass === passes.length - 1) break
    }
    scored.sort((a, b) => b.score - a.score || a.term - b.term)
    const candidates = scored.slice(0, CANDIDATES)
    labels.push(
      describe(
        candidates.map((s) => s.term),
        vocab,
        (t) => count[c * V + t]!,
        topTerms,
        maxLabelLength,
        c
      )
    )
  }
  return labels
}

function describe(
  candidates: number[],
  vocab: string[],
  countOf: (term: number) => number,
  topTerms: number,
  maxLabelLength: number,
  id: number
): ClusterLabel {
  const bigrams = candidates.filter((t) => vocab[t]!.includes(' '))

  // A unigram that mostly occurs inside one bigram is represented by that
  // bigram ("source" → "open source").
  const represent = (t: number): string => {
    const term = vocab[t]!
    if (term.includes(' ')) return term
    let best = -1
    for (const b of bigrams) {
      if (!vocab[b]!.split(' ').includes(term)) continue
      if (best < 0 || countOf(b) > countOf(best)) best = b
    }
    return best >= 0 && countOf(best) >= 0.5 * countOf(t) ? vocab[best]! : term
  }

  const select = (strict: boolean, limit: number): string[] => {
    const out: string[] = []
    const used = new Set<string>()
    for (const t of candidates) {
      if (out.length >= limit) break
      const term = represent(t)
      if (out.includes(term)) continue
      const words = term.split(' ').map(stem)
      // Labels avoid any shared word; term lists only skip pure repeats.
      if (
        strict
          ? words.some((w) => used.has(w))
          : words.every((w) => used.has(w))
      )
        continue
      out.push(term)
      for (const w of words) used.add(w)
    }
    return out
  }

  const terms = select(false, topTerms)
  const parts = select(true, 3)
  let label = parts.slice(0, 2).join(' · ')
  if (parts.length > 2 && label.length + 3 + parts[2]!.length <= maxLabelLength)
    label += ` · ${parts[2]}`
  return { label: label || `cluster ${id + 1}`, terms }
}
