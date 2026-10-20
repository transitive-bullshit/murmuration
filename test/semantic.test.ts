import { beforeAll, describe, expect, it } from 'vitest'

import {
  buildSemanticMap,
  extractTerms,
  tokenize,
  type SemanticResult
} from '../src/server/semantic'
import { labelClusters } from '../src/server/semantic/labels'
import { clusterAnchors } from '../src/server/semantic/layout'
import { mulberry32 } from '../src/server/semantic/random'
import type { Csr } from '../src/server/semantic/sparse'

const TOPICS = {
  cooking: {
    words: [
      'recipe',
      'garlic',
      'onion',
      'pasta',
      'oven',
      'bake',
      'sauce',
      'butter',
      'flour',
      'roast',
      'chicken',
      'simmer',
      'tomato',
      'basil',
      'dough'
    ],
    phrases: ['olive oil', 'cast iron']
  },
  typescript: {
    words: [
      'typescript',
      'compiler',
      'generics',
      'inference',
      'tsc',
      'interface',
      'union',
      'narrowing',
      'declaration',
      'emit',
      'module',
      'strict',
      'checker',
      'syntax',
      'overload'
    ],
    phrases: ['type checker', 'type inference']
  },
  football: {
    words: [
      'goal',
      'striker',
      'midfield',
      'penalty',
      'league',
      'match',
      'referee',
      'keeper',
      'tackle',
      'offside',
      'corner',
      'stadium',
      'transfer',
      'fans',
      'derby'
    ],
    phrases: ['premier league', 'free kick']
  },
  astronomy: {
    words: [
      'telescope',
      'galaxy',
      'nebula',
      'planet',
      'orbit',
      'star',
      'comet',
      'eclipse',
      'jupiter',
      'saturn',
      'astronomer',
      'supernova',
      'cosmic',
      'moon',
      'asteroid'
    ],
    phrases: ['black hole', 'dark matter']
  }
}
type Topic = keyof typeof TOPICS
const TOPIC_NAMES = Object.keys(TOPICS) as Topic[]
// Stopwords / chatter plus a few content words shared by every topic.
const NOISE = [
  'today',
  'really',
  'lol',
  'honestly',
  'the',
  'is',
  'just',
  'weekend',
  'morning',
  'friends',
  'photo',
  'video'
]

function syntheticCorpus(
  perTopic: number,
  seed = 7
): { texts: string[]; topics: Topic[] } {
  const rng = mulberry32(seed)
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)]!
  const texts: string[] = []
  const topics: Topic[] = []
  for (let i = 0; i < perTopic; i++) {
    for (const topic of TOPIC_NAMES) {
      const { words, phrases } = TOPICS[topic]
      const parts: string[] = []
      if (rng() < 0.3) parts.push(`@user${Math.floor(rng() * 50)}`)
      const count = 4 + Math.floor(rng() * 5)
      for (let w = 0; w < count; w++)
        parts.push(rng() < 0.15 ? pick(phrases) : pick(words))
      for (let w = Math.floor(rng() * 4); w > 0; w--)
        parts.splice(Math.floor(rng() * parts.length), 0, pick(NOISE))
      if (rng() < 0.4)
        parts.push(`https://t.co/${Math.floor(rng() * 1e6).toString(36)}`)
      texts.push(parts.join(rng() < 0.5 ? ' ' : ', '))
      topics.push(topic)
    }
  }
  return { texts, topics }
}

function purity(result: SemanticResult, topics: Topic[]): number {
  const counts = new Map<number, Map<Topic, number>>()
  let total = 0
  result.cluster.forEach((c, i) => {
    if (c < 0) return
    total++
    const byTopic = counts.get(c) ?? new Map<Topic, number>()
    byTopic.set(topics[i]!, (byTopic.get(topics[i]!) ?? 0) + 1)
    counts.set(c, byTopic)
  })
  let majority = 0
  for (const byTopic of counts.values())
    majority += Math.max(...byTopic.values())
  return majority / total
}

function majorityTopic(
  result: SemanticResult,
  topics: Topic[],
  id: number
): Topic {
  const byTopic = new Map<Topic, number>()
  result.cluster.forEach((c, i) => {
    if (c === id) byTopic.set(topics[i]!, (byTopic.get(topics[i]!) ?? 0) + 1)
  })
  return [...byTopic.entries()].sort((a, b) => b[1] - a[1])[0]![0]
}

describe('tokenizer', () => {
  it('drops URLs, mentions, entities, numbers and stopwords', () => {
    const tokens = tokenize(
      'RT @someone: Check out https://t.co/AbC123 — the TypeScript compiler is really fast &amp; open-source! 2024 #RustLang'
    )
    expect(tokens).toEqual([
      'typescript',
      'compiler',
      'fast',
      'open',
      'source',
      'rustlang'
    ])
    for (const dropped of [
      'rt',
      'someone',
      'check',
      'https',
      'abc123',
      'the',
      'is',
      'really',
      'amp',
      '2024'
    ]) {
      expect(tokens).not.toContain(dropped)
    }
  })

  it('builds bigrams only from directly adjacent kept tokens', () => {
    const terms = extractTerms(
      'The TypeScript compiler is open source. Galaxy brain, black hole! I love state of the art'
    )
    expect(terms).toContain('typescript compiler')
    expect(terms).toContain('open source')
    expect(terms).toContain('black hole')
    // Punctuation and dropped stopwords break bigram runs.
    expect(terms).not.toContain('source galaxy')
    expect(terms).not.toContain('brain black')
    expect(terms).not.toContain('state art')
  })

  it('keeps model names and folds js suffixes', () => {
    expect(tokenize('GPT-4 vs gpt-3.5 on Next.js and c++')).toEqual([
      'gpt-4',
      'gpt-3.5',
      'nextjs',
      'cpp'
    ])
  })
})

describe('labelClusters', () => {
  it('prefers a bigram over its own constituent unigrams', () => {
    const vocab = ['open', 'source', 'open source', 'rust', 'garlic', 'pasta']
    const docs: number[][] = []
    for (let i = 0; i < 10; i++) docs.push(i < 6 ? [0, 1, 2, 3] : [0, 1, 2])
    for (let i = 0; i < 10; i++) docs.push([4, 5])
    const indptr = Int32Array.from([
      0,
      ...docs.map((_, i) => docs.slice(0, i + 1).flat().length)
    ])
    const indices = Int32Array.from(docs.flat())
    const matrix: Csr = {
      rows: docs.length,
      cols: vocab.length,
      indptr,
      indices,
      data: new Float32Array(indices.length).fill(1)
    }
    const cluster = Int16Array.from(docs, (_, i) => (i < 10 ? 0 : 1))
    const [first, second] = labelClusters(matrix, vocab, cluster, 2)
    expect(first!.label).toBe('open source · rust')
    expect(first!.terms).toEqual(['open source', 'rust'])
    expect(second!.label).toMatch(/^(garlic · pasta|pasta · garlic)$/)
  })
})

describe('buildSemanticMap', () => {
  const { texts, topics } = syntheticCorpus(150)
  // Docs with no usable tokens must come back unclustered.
  const empties = ['lol 😂 https://t.co/xyz', '@someone thanks!!', '']
  const allTexts = [...texts, ...empties]
  let result: SemanticResult
  const progress: Array<[string, number]> = []

  beforeAll(async () => {
    result = await buildSemanticMap(allTexts, {
      k: 4,
      onProgress: (phase, fraction) => progress.push([phase, fraction])
    })
  })

  it('recovers the synthetic topics with readable labels', () => {
    expect(purity(result, topics)).toBeGreaterThan(0.95)
    expect(result.clusters).toHaveLength(4)
    const seen = new Set<Topic>()
    for (const cluster of result.clusters) {
      const topic = majorityTopic(result, topics, cluster.id)
      seen.add(topic)
      const vocabulary = new Set([
        ...TOPICS[topic].words,
        ...TOPICS[topic].phrases.flatMap((p) => [p, ...p.split(' ')])
      ])
      const labelTerms = cluster.label.split(' · ')
      expect(
        labelTerms.some(
          (term) => vocabulary.has(term) || vocabulary.has(`${term}s`)
        )
      ).toBe(true)
      expect(cluster.terms.length).toBeGreaterThanOrEqual(3)
    }
    expect(seen.size).toBe(4)
  })

  it('keeps purity with the default k', async () => {
    const auto = await buildSemanticMap(texts)
    expect(auto.clusters.length).toBe(12)
    expect(purity(auto, topics)).toBeGreaterThan(0.95)
  })

  it('returns well-formed output sizes and ranges', () => {
    const n = allTexts.length
    expect(result.coords).toHaveLength(n * 3)
    expect(result.cluster).toHaveLength(n)
    expect(result.coords.every(Number.isFinite)).toBe(true)

    const radii = Array.from({ length: n }, (_, i) =>
      Math.hypot(
        result.coords[i * 3]!,
        result.coords[i * 3 + 1]!,
        result.coords[i * 3 + 2]!
      )
    )
    const inside = radii.filter((r) => r <= 1 + 1e-6).length / n
    expect(inside).toBeGreaterThanOrEqual(0.97)
    expect(Math.max(...radii)).toBeLessThan(3)

    for (let i = texts.length; i < n; i++) expect(result.cluster[i]).toBe(-1)
    for (let i = 0; i < texts.length; i++)
      expect(result.cluster[i]).toBeGreaterThanOrEqual(0)

    const { clusters } = result
    expect(clusters.map((c) => c.id)).toEqual(clusters.map((_, i) => i))
    for (let i = 1; i < clusters.length; i++)
      expect(clusters[i - 1]!.size).toBeGreaterThanOrEqual(clusters[i]!.size)
    for (const c of clusters) {
      const members = [...result.cluster.keys()].filter(
        (i) => result.cluster[i] === c.id
      )
      expect(members).toHaveLength(c.size)
      for (let axis = 0; axis < 3; axis++) {
        const mean =
          members.reduce((sum, i) => sum + result.coords[i * 3 + axis]!, 0) /
          members.length
        expect(c.centroid[axis]).toBeCloseTo(mean, 4)
      }
    }

    const phases = new Set(progress.map(([phase]) => phase))
    for (const phase of [
      'tokenizing',
      'tf-idf',
      'svd',
      'clustering',
      'labeling',
      'projecting'
    ]) {
      expect(phases).toContain(phase)
      expect(result.timings[phase]).toBeGreaterThanOrEqual(0)
    }
    expect(
      progress.every(([, fraction]) => fraction >= 0 && fraction <= 1)
    ).toBe(true)
  })

  it('is deterministic for a given seed', async () => {
    const a = await buildSemanticMap(texts, { k: 4, seed: 3 })
    const b = await buildSemanticMap(texts, { k: 4, seed: 3 })
    expect(Array.from(a.coords)).toEqual(Array.from(b.coords))
    expect(Array.from(a.cluster)).toEqual(Array.from(b.cluster))
    expect(a.clusters).toEqual(b.clusters)
  })

  it('handles degenerate input', async () => {
    const empty = await buildSemanticMap([])
    expect(empty.coords).toHaveLength(0)
    expect(empty.clusters).toEqual([])

    const noise = await buildSemanticMap(['lol', 'thanks!', 'https://t.co/abc'])
    expect(Array.from(noise.cluster)).toEqual([-1, -1, -1])
    expect(noise.coords.every(Number.isFinite)).toBe(true)
  })
})

describe('layout stability', () => {
  it('keeps cluster anchors finite when centroids are nearly identical', () => {
    // Two unit centroids 0.25 rad apart used to make the stress refinement
    // diverge to NaN.
    const d = 8
    const centroids = new Float64Array(2 * d)
    centroids[0] = 1
    centroids[d] = Math.cos(0.25)
    centroids[d + 1] = Math.sin(0.25)
    const anchors = clusterAnchors(centroids, 2, d, mulberry32(1))
    expect(Array.from(anchors).every(Number.isFinite)).toBe(true)
  })
})
