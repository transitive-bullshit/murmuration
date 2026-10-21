import { existsSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import type { HeldWork } from '../shared/types'
import {
  captionTweetImages,
  embedTexts,
  embeddingInput,
  localEmbedder,
  openaiCaptioners,
  openaiEmbedder,
  planEmbeddings,
  planTweetCaptions,
  type CaptionerSpec,
  type EmbedderSpec,
  type Embeddings
} from './embed'
import type { FanoutProgress } from './fanout'
import { assertLocked, type BuildLock } from './lock'

// The paid part of a build. With OPENAI_API_KEY, image captions and tweet
// embeddings are OpenAI requests; only uncached items cost anything. Each
// build first plans them (counts what isn't cached), holds them back when
// they're over the spend caps or the pause switch is on, and requests them
// only while holding the build lock (`lock.ts`).

/**
 * What a build does with paid work over the caps, or while `.cache/PAUSE`
 * exists:
 *
 * - `'capped'` (default; the dev server): builds from what's cached and says
 *   what's waiting in meta.warnings; under the caps, it pays
 * - `'strict'` (`pnpm export`): throws a SpendHeldError; under the caps, it pays
 * - `'approved'` (`pnpm export --yes`): pays for everything; throws while paused
 */
export type SpendPolicy = 'capped' | 'strict' | 'approved'

export interface SpendCaps {
  /** new image captions one build requests without approval */
  captions: number
  /** new embedding inputs one build requests without approval */
  embeddings: number
}

// A sync's worth of new tweets fits; a first build or an invalidated cache
// (thousands of items, a few dollars) needs `--yes`.
export const DEFAULT_CAPS: SpendCaps = { captions: 200, embeddings: 2000 }

const Cap = z.coerce.number().int().nonnegative()

/** The caps, overridable with MURMURATION_MAX_NEW_CAPTIONS / MURMURATION_MAX_NEW_EMBEDDINGS. */
export function spendCaps(
  env: Record<string, string | undefined> = process.env
): SpendCaps {
  const read = (name: string, fallback: number) => {
    const raw = env[name]?.trim()
    if (!raw) return fallback
    const parsed = Cap.safeParse(raw)
    if (!parsed.success)
      throw new Error(`${name} must be a whole number, got "${raw}"`)
    return parsed.data
  }
  return {
    captions: read('MURMURATION_MAX_NEW_CAPTIONS', DEFAULT_CAPS.captions),
    embeddings: read('MURMURATION_MAX_NEW_EMBEDDINGS', DEFAULT_CAPS.embeddings)
  }
}

/** While this file exists, no paid request starts. */
export const pauseFile = (cacheDir: string) => path.join(cacheDir, 'PAUSE')
export const isPaused = (cacheDir: string) => existsSync(pauseFile(cacheDir))

export interface SpendPlan {
  /** whether any of it costs money; a local model is free */
  paid: boolean
  /** the embedder: 'openai' or 'local' */
  provider: string
  /** set when images get captions (OpenAI only) */
  captionModel?: string
  embeddingModel: string
  /** uncached images to caption */
  captions: number
  /** uncached embedding inputs, counting tweets whose new captions change theirs */
  embeddings: number
}

export class SpendHeldError extends Error {
  override name = 'SpendHeldError'
  constructor(
    readonly held: HeldWork,
    caps: SpendCaps
  ) {
    super(
      held.reason === 'pause'
        ? `Paid work is paused by .cache/PAUSE, with ${describeWork(held)} waiting. Delete the file and re-run.`
        : `This build would request ${describeWork(held)} from OpenAI, over the limit of ${fmt(caps.captions)} captions and ${fmt(caps.embeddings)} embeddings per build (MURMURATION_MAX_NEW_CAPTIONS, MURMURATION_MAX_NEW_EMBEDDINGS). Nothing was requested: \`pnpm export --plan\` shows the plan, \`pnpm export --yes\` pays for it.`
    )
  }
}

const fmt = (n: number) => n.toLocaleString('en-US')

/** "1,234 new image captions and 56 new embeddings" */
export function describeWork(work: {
  captions: number
  embeddings: number
}): string {
  const count = (n: number, noun: string) =>
    `${fmt(n)} new ${noun}${n === 1 ? '' : 's'}`
  const parts = [
    work.captions ? count(work.captions, 'image caption') : '',
    work.embeddings ? count(work.embeddings, 'embedding') : ''
  ].filter(Boolean)
  return parts.join(' and ') || 'nothing'
}

/** The note in meta.warnings for a dev build that held paid work back. */
export function heldWarning(held: HeldWork): string {
  return held.reason === 'pause'
    ? `Paid work is paused by .cache/PAUSE, with ${describeWork(held)} waiting. Delete the file and refresh to continue.`
    : `OpenAI work is waiting (${describeWork(held)}): more than the dev server requests on its own. Run \`pnpm export --yes\` to pay for it; until then, topics use what's cached.`
}

const overCaps = (work: HeldWork | SpendPlan, caps: SpendCaps) =>
  work.captions > caps.captions || work.embeddings > caps.embeddings

/** Why `plan` can't be paid for now under `policy`, if it can't. */
export function holdReason(
  plan: SpendPlan,
  policy: SpendPolicy,
  cacheDir: string,
  caps: SpendCaps
): HeldWork['reason'] | undefined {
  if (!plan.paid || (!plan.captions && !plan.embeddings)) return undefined
  if (isPaused(cacheDir)) return 'pause'
  if (policy !== 'approved' && overCaps(plan, caps)) return 'cap'
  return undefined
}

/** Whether work a build held back would still be held back now. */
export function stillHeld(held: HeldWork, cacheDir: string): boolean {
  return held.reason === 'pause'
    ? isPaused(cacheDir)
    : overCaps(held, spendCaps())
}

export interface PaidProviders {
  /** image captions (OpenAI only, so none without a key) */
  captioner?: CaptionerSpec
  /** the preferred embedder first; later ones are free fallbacks */
  embedders: [EmbedderSpec, ...EmbedderSpec[]]
}

/** OpenAI with a key (captions and embeddings), else the local model. */
export function defaultProviders(
  cacheDir: string,
  apiKey?: string
): PaidProviders {
  return {
    captioner: apiKey ? openaiCaptioners({ apiKey }) : undefined,
    embedders: apiKey
      ? [openaiEmbedder({ apiKey }), localEmbedder(cacheDir)]
      : [localEmbedder(cacheDir)]
  }
}

/** One entry per tweet, index-aligned. */
export interface PaidInput {
  ids: string[]
  /** tweet text, '' for X's placeholders */
  texts: string[]
  /** the tweet's image URLs */
  media: string[][]
}

/** What `captionAndEmbed` would request. Reads the caches; requests nothing. */
export async function planPaidWork(
  input: PaidInput,
  options: { cacheDir: string; providers: PaidProviders }
): Promise<SpendPlan> {
  const { cacheDir, providers } = options
  const { captioner, embedders } = providers
  const [embedder] = embedders
  const captions = captioner
    ? planTweetCaptions(input.media, { cacheDir, captioner })
    : undefined
  // A tweet getting a new caption gets a new embedding input, too.
  const todo = new Set(captions?.todo)
  const changing = new Set<number>()
  input.media.forEach((urls, i) => {
    if (urls.some((url) => todo.has(url))) changing.add(i)
  })
  const inputs = await embeddingInputs(input.texts, captions?.captions)
  return {
    paid: !!captioner || !!embedder.paid,
    provider: embedder.provider,
    captionModel: captioner?.model,
    embeddingModel: embedder.model,
    captions: todo.size,
    embeddings: await planEmbeddings(input.ids, inputs, {
      cacheDir,
      embedder,
      changing
    })
  }
}

export interface PaidOptions {
  cacheDir: string
  providers: PaidProviders
  /** the build lock of `cacheDir` */
  lock: BuildLock
  /** default 'capped' */
  spend?: SpendPolicy
  /** default `spendCaps()` */
  caps?: SpendCaps
  /** cancels the work: in-flight requests are aborted, finished items stay cached */
  signal?: AbortSignal
  onProgress?: (phase: string, fraction: number) => void
  /** default console.warn */
  log?: (line: string) => void
  /** redacted from log lines (the API key) */
  secret?: string
}

export interface PaidResult {
  plan: SpendPlan
  /** per tweet: captions of its images */
  captions: string[][]
  /** undefined when no embedder worked; the map then uses word statistics */
  embedding?: Embeddings
  /** paid work this build left for later */
  held?: HeldWork
  /** user-facing notes for meta.warnings */
  warnings: string[]
  timings: Record<string, number>
}

/**
 * Captions images and embeds tweets, paying only for what `spend` allows.
 * Requires the build lock. Cancelling `signal` rejects with its reason.
 */
export async function captionAndEmbed(
  input: PaidInput,
  options: PaidOptions
): Promise<PaidResult> {
  assertLocked(options.lock, options.cacheDir)
  const { cacheDir, signal } = options
  const spend = options.spend ?? 'capped'
  const caps = options.caps ?? spendCaps()
  const report = options.onProgress ?? (() => {})
  const log = (line: string) =>
    (options.log ?? console.warn)(redact(line, options.secret))
  const timings: Record<string, number> = {}
  let t0 = performance.now()
  const lap = (label: string) => {
    timings[label] = Math.round(performance.now() - t0)
    t0 = performance.now()
  }

  const { captioner, embedders } = options.providers
  report(
    captioner || embedders[0].paid
      ? 'Planning paid requests'
      : 'Checking caches',
    0
  )
  const plan = await planPaidWork(input, options)
  signal?.throwIfAborted()
  lap('plan')
  const reason = holdReason(plan, spend, cacheDir, caps)
  const planned = { captions: plan.captions, embeddings: plan.embeddings }
  if (reason && spend !== 'capped')
    throw new SpendHeldError({ reason, ...planned }, caps)

  const warnings: string[] = []
  const step: StepOptions = {
    ...options,
    report,
    log,
    warnings,
    cachedOnly: reason !== undefined,
    paused: () => isPaused(cacheDir)
  }
  const captions = await describeImages(input.media, step)
  lap('captions')
  if (captions.paused && spend !== 'capped')
    throw new SpendHeldError(
      {
        reason: 'pause',
        captions: captions.paused,
        embeddings: plan.embeddings
      },
      caps
    )
  // Paused during captions: request no embeddings either.
  const embedOnlyCached = step.cachedOnly || captions.paused > 0
  const embedding = await embedTweets(input, captions.captions, {
    ...step,
    cachedOnly: embedOnlyCached
  })
  lap('embed')
  const embeddingsPaused = embedding?.paused ?? 0
  if (embeddingsPaused && spend !== 'capped')
    throw new SpendHeldError(
      { reason: 'pause', captions: 0, embeddings: embeddingsPaused },
      caps
    )

  const held: HeldWork | undefined = reason
    ? { reason, ...planned }
    : captions.paused || embeddingsPaused
      ? {
          reason: 'pause',
          captions: captions.paused,
          embeddings: embedOnlyCached ? plan.embeddings : embeddingsPaused
        }
      : undefined
  if (held) {
    log(
      `[murmuration] ${held.reason === 'pause' ? 'paused by .cache/PAUSE' : 'over the spend caps'}: left ${describeWork(held)} for later`
    )
    warnings.push(heldWarning(held))
  }
  return {
    plan,
    captions: captions.captions,
    embedding,
    held,
    warnings,
    timings
  }
}

interface StepOptions extends PaidOptions {
  report: (phase: string, fraction: number) => void
  log: (line: string) => void
  /** user-facing notes collected into meta.warnings */
  warnings: string[]
  /** request nothing paid; use what's cached */
  cachedOnly: boolean
  paused: () => boolean
}

const redact = (text: string, secret?: string) =>
  secret ? text.replaceAll(secret, '***') : text

const errorMessage = (err: unknown, secret?: string) =>
  redact(err instanceof Error ? err.message : String(err), secret)

/** "Embedding tweets (1,200 of 44,739 · 3 skipped)" */
const countPhase = (phase: string, { done, failed, total }: FanoutProgress) =>
  `${phase} (${done.toLocaleString()} of ${total.toLocaleString()}${failed ? ` · ${failed.toLocaleString()} skipped` : ''})`

async function embeddingInputs(
  texts: readonly string[],
  captions?: readonly string[][],
  signal?: AbortSignal
): Promise<string[]> {
  const inputs: string[] = []
  for (const [i, text] of texts.entries()) {
    inputs.push(embeddingInput(text, captions?.[i]))
    // Regex-heavy cleanup: let the dev server breathe.
    if (i % 2000 === 1999) {
      await new Promise((resolve) => setImmediate(resolve))
      signal?.throwIfAborted()
    }
  }
  return inputs
}

/** Captions for each tweet's first images (OpenAI only), cached per media URL. */
async function describeImages(
  media: string[][],
  options: StepOptions
): Promise<{ captions: string[][]; paused: number }> {
  const none = { captions: media.map(() => []), paused: 0 }
  const { captioner } = options.providers
  if (!captioner) return none
  options.report('Describing images', 0)
  try {
    const result = await captionTweetImages(media, {
      ...options,
      captioner,
      onProgress: (p) =>
        options.report(
          countPhase('Describing images', p),
          p.done / Math.max(1, p.total)
        )
    })
    options.signal?.throwIfAborted()
    if (result.warning) options.warnings.push(result.warning)
    if (result.error) {
      options.log(
        `[murmuration] image captions stopped early: ${errorMessage(result.error)}`
      )
      options.warnings.push(
        'Describing images stopped early; the rest will be described on the next rebuild.'
      )
    }
    return { captions: result.captions, paused: result.paused }
  } catch (err) {
    options.signal?.throwIfAborted()
    options.log(
      `[murmuration] image captions unavailable: ${errorMessage(err)}`
    )
    options.warnings.push(
      'Images could not be described this time; topics use tweet text only.'
    )
    return none
  } finally {
    options.report('Describing images', 1)
  }
}

/**
 * Embeds tweet text plus image captions with the best available provider:
 * OpenAI (when a key is set), then local transformers.js. Returns undefined
 * when neither works, so the semantic map falls back to bag-of-words LSA.
 */
async function embedTweets(
  input: PaidInput,
  captions: string[][],
  options: StepOptions
): Promise<Embeddings | undefined> {
  const inputs = await embeddingInputs(input.texts, captions, options.signal)
  // Held back, only the preferred embedder's cache counts: a fallback would
  // make a different map.
  const embedders = options.cachedOnly
    ? options.providers.embedders.slice(0, 1)
    : options.providers.embedders
  for (const embedder of embedders) {
    options.report('Embedding tweets', 0)
    try {
      const result = await embedTexts(input.ids, inputs, {
        ...options,
        embedder,
        // Only paid work is held back or paused.
        cachedOnly: options.cachedOnly && !!embedder.paid,
        paused: embedder.paid ? options.paused : undefined,
        onProgress: (p) =>
          options.report(
            countPhase('Embedding tweets', p),
            p.done / Math.max(1, p.total)
          )
      })
      if (result.warning) options.warnings.push(result.warning)
      // With most vectors still to come, word statistics make a better map
      // than imputing the majority from the rest.
      if (
        options.cachedOnly &&
        result.missing * 2 > inputs.filter(Boolean).length
      )
        return undefined
      return result
    } catch (err) {
      options.signal?.throwIfAborted()
      options.log(
        `[murmuration] ${embedder.provider} embeddings failed, trying the next option: ${errorMessage(err)}`
      )
      options.warnings.push(
        embedder.provider === 'openai'
          ? 'OpenAI embeddings failed this time; topics use the local model instead.'
          : 'Local embeddings failed; topics fall back to word statistics.'
      )
    } finally {
      options.report('Embedding tweets', 1)
    }
  }
  return undefined
}
