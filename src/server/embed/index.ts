import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { isHTTPError } from 'ky'
import { z } from 'zod'

import { fanout, type FanoutProgress } from '../fanout'
import { createClock } from '../semantic/scheduler'
import { VectorCache, dequantizeInto, quantize, vectorKey } from './cache'
import { captionImages } from './captions'
import { localEmbedder } from './local'
import {
  CAPTION_MODEL,
  openaiBatchCaptioner,
  openaiCaptioner,
  openaiEmbedder
} from './openai'
import type { EmbedderSpec } from './types'

export { cleanTweetText, embeddingInput } from './text'
export { localEmbedder } from './local'
export { openaiEmbedder } from './openai'
export type { Embedder, EmbedderSpec } from './types'

export interface EmbedOptions {
  /** directory for the per-tweet vector cache (and local model weights) */
  cacheDir: string
  /** defaults to OpenAI when OPENAI_API_KEY is set, else local transformers.js */
  embedder?: EmbedderSpec
  onProgress?: (progress: FanoutProgress) => void
  log?: (line: string) => void
  now?: () => number
}

export interface Embeddings {
  /** n × dim, L2-normalized; all-zero rows for empty inputs and failures */
  vectors: Float32Array
  dim: number
  provider: string
  model: string
  /** inputs embedded in this run (the rest came from the cache) */
  embedded: number
  /** non-empty inputs left without a vector (failed now or earlier) */
  missing: number
  /** user-facing note when many inputs failed */
  warning?: string
}

/** OpenAI when a key is configured, otherwise local transformers.js. */
export function defaultEmbedder(
  cacheDir: string,
  apiKey = process.env.OPENAI_API_KEY
): EmbedderSpec {
  return apiKey ? openaiEmbedder({ apiKey }) : localEmbedder(cacheDir)
}

const MAX_ATTEMPTS = 4

const Failures = z.record(
  z.string(),
  z.object({ attempts: z.number().int(), at: z.number() })
)

/**
 * Process-wide mutual exclusion that survives dev-server module reloads: a
 * second build in the same process waits for the first to finish a paid phase
 * and then finds its results in the cache instead of repeating the requests.
 */
function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
  const g = globalThis as { __murmurationLocks?: Map<string, Promise<unknown>> }
  const locks = (g.__murmurationLocks ??= new Map())
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(run)
  locks.set(key, next)
  void next
    .finally(() => locks.get(key) === next && locks.delete(key))
    .catch(() => {})
  return next
}

function classifyError(err: unknown): 'fatal' | 'item' {
  if (isHTTPError(err))
    return [401, 403, 404].includes(err.response.status) ? 'fatal' : 'item'
  return err instanceof Error &&
    /embedding worker (exited|closed)/u.test(err.message)
    ? 'fatal'
    : 'item'
}

/**
 * Embeds one input per tweet. Vectors are cached per tweet id + model + hash
 * of the full input in `<cacheDir>/embeddings-<model>.bin`, so a rebuild after
 * a sync only embeds new or changed inputs. Failed batches don't fail the run:
 * their inputs are recorded (retried on later runs, up to 4 attempts) and get
 * zero vectors here; empty inputs get zero vectors too. Throws only when the
 * error budget is exhausted (see fanout), e.g. bad key or service down.
 */
export function embedTexts(
  ids: string[],
  inputs: string[],
  options: EmbedOptions
): Promise<Embeddings> {
  const spec = options.embedder ?? defaultEmbedder(options.cacheDir)
  const base = path.join(
    options.cacheDir,
    `embeddings-${spec.model.replace(/[^\w.-]+/gu, '_')}`
  )
  return exclusive(base, () => embedUnlocked(spec, base, ids, inputs, options))
}

async function embedUnlocked(
  spec: EmbedderSpec,
  base: string,
  ids: string[],
  inputs: string[],
  options: EmbedOptions
): Promise<Embeddings> {
  const now = options.now ?? Date.now
  const clock = createClock(20)
  const { dim } = spec
  const cache = await VectorCache.open(`${base}.bin`, dim, clock)
  const failuresFile = `${base}.failures.json`
  let failures: z.infer<typeof Failures> = {}
  try {
    failures = existsSync(failuresFile)
      ? Failures.parse(JSON.parse(readFileSync(failuresFile, 'utf8')))
      : {}
  } catch {
    failures = {}
  }

  const n = inputs.length
  const keys: string[] = []
  const todo = new Map<string, string>()
  for (let i = 0; i < n; i++) {
    const input = inputs[i] ?? ''
    const key = input ? vectorKey(ids[i] ?? String(i), spec.model, input) : ''
    keys.push(key)
    if (
      key &&
      !cache.entries.has(key) &&
      (failures[key]?.attempts ?? 0) < MAX_ATTEMPTS
    )
      todo.set(key, input)
    if ((i & 1023) === 0 && clock.due()) await clock.pause()
  }

  let failedInputs = 0
  if (todo.size) {
    const embedder = await spec.load()
    try {
      // Similar lengths per batch keep padding (and wasted compute) low.
      const queue = [...todo].sort((a, b) => a[1].length - b[1].length)
      const batches: Array<Array<[string, string]>> = []
      for (let s = 0; s < queue.length;) {
        let e = s + 1
        while (
          e < queue.length &&
          e - s < embedder.maxBatch(queue[e]![1].length)
        )
          e++
        batches.push(queue.slice(s, e))
        s = e
      }
      let inputsDone = 0
      await fanout(
        batches,
        async (batch, { signal }) => {
          try {
            const result = await embedder.embed(
              batch.map(([, input]) => input),
              signal
            )
            if (result.dim !== dim)
              throw new Error(`expected ${dim}-d embeddings, got ${result.dim}`)
            await cache.append(
              batch.map(([key], r) => [
                key,
                quantize(result.data.subarray(r * dim, (r + 1) * dim))
              ])
            )
            for (const [key] of batch) delete failures[key]
          } finally {
            inputsDone += batch.length
          }
        },
        {
          label: `${spec.provider} embedding batches`,
          concurrency: embedder.concurrency,
          classify: classifyError,
          describe: (batch) => `a batch of ${batch.length}`,
          log: options.log,
          onFailure: (batch) => {
            failedInputs += batch.length
            for (const [key] of batch)
              failures[key] = {
                attempts: (failures[key]?.attempts ?? 0) + 1,
                at: now()
              }
          },
          onProgress: () =>
            options.onProgress?.({
              done: inputsDone,
              failed: failedInputs,
              total: queue.length
            })
        }
      )
    } finally {
      await embedder.close?.()
    }
  }

  const vectors = new Float32Array(n * dim)
  let missing = 0
  for (let i = 0; i < n; i++) {
    const q = keys[i] ? cache.entries.get(keys[i]!) : undefined
    if (q) dequantizeInto(q, vectors, i * dim)
    else if (keys[i]) missing++
    if ((i & 1023) === 0 && clock.due()) await clock.pause()
  }
  const live = new Set(keys.filter(Boolean))
  await cache.compact(live)
  for (const key of Object.keys(failures))
    if (!live.has(key)) delete failures[key]
  await writeFile(failuresFile, JSON.stringify(failures))
  const warning =
    failedInputs > 20 || (failedInputs > 0 && failedInputs >= 0.02 * todo.size)
      ? `${failedInputs.toLocaleString()} of ${todo.size.toLocaleString()} tweets couldn't be embedded; they're placed by their nearest text neighbors and retried on the next rebuild.`
      : undefined
  return {
    vectors,
    dim,
    provider: spec.provider,
    model: spec.model,
    embedded: todo.size - failedInputs,
    missing,
    warning
  }
}

/**
 * Prefix of each vector, re-normalized. Valid for Matryoshka-trained models
 * such as text-embedding-3, whose leading dimensions carry most of the signal.
 */
export function truncateVectors(
  vectors: Float32Array,
  dim: number,
  keep: number
): Float32Array {
  if (keep >= dim) return vectors
  const n = vectors.length / dim
  const out = new Float32Array(n * keep)
  for (let i = 0; i < n; i++) {
    let norm = 0
    for (let t = 0; t < keep; t++) norm += vectors[i * dim + t]! ** 2
    const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0
    for (let t = 0; t < keep; t++)
      out[i * keep + t] = vectors[i * dim + t]! * inv
  }
  return out
}

export interface ImageCaptions {
  /** per tweet: captions of its first images, in order */
  captions: string[][]
  model: string
  requested: number
  failed: number
  warning?: string
  error?: unknown
}

/**
 * Captions every tweet's images with OpenAI's vision model (8 images per
 * request, 16 requests in flight), cached per media URL in
 * `<cacheDir>/captions-<model>.jsonl`.
 */
export function captionTweetImages(
  mediaUrls: readonly (readonly string[])[],
  options: {
    cacheDir: string
    apiKey: string
    onProgress?: (progress: FanoutProgress) => void
    log?: (line: string) => void
  }
): Promise<ImageCaptions> {
  const file = path.join(options.cacheDir, `captions-${CAPTION_MODEL}.jsonl`)
  return exclusive(file, async () => {
    const result = await captionImages(mediaUrls.flat(), {
      file,
      captioner: openaiCaptioner({ apiKey: options.apiKey }),
      batchCaptioner: openaiBatchCaptioner({ apiKey: options.apiKey }),
      groupSize: 8,
      classify: classifyError,
      concurrency: 16,
      onProgress: options.onProgress,
      log: options.log
    })
    return {
      captions: mediaUrls.map((urls) =>
        urls.flatMap((url) => result.captions.get(url) ?? [])
      ),
      model: CAPTION_MODEL,
      requested: result.requested,
      failed: result.failed,
      warning: result.warning,
      error: result.error
    }
  })
}
