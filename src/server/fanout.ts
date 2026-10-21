import pMap from 'p-map'

/**
 * Concurrent per-item work (network requests, mostly) with an error budget.
 *
 * - Each failed item logs one concise line and the run continues; its result
 *   is `undefined`.
 * - The run stops early (rejecting with a `FanoutAbortedError`) only when
 *   `classify` calls an error fatal (bad key, missing model), after
 *   `maxStreak` consecutive failures, or when more than `maxFailureRate` of at
 *   least `minSample` finished items failed. In-flight work is cancelled via
 *   the `AbortSignal` handed to `run`.
 * - When failures stay under those limits but reach `warnRate` of all items
 *   (or more than `warnCount`), the result carries a user-facing `warning`.
 * - Once `paused()` returns true, no new item starts; in-flight ones finish,
 *   and the rest are counted in `paused` (results `undefined`, not failures).
 *
 * Retrying transient errors (429, 5xx) belongs inside `run`, e.g. ky's retry.
 *
 * @example
 *   const { results, failed, warning } = await fanout(urls, (url, { signal }) => fetchThing(url, signal), {
 *     label: 'image captions',
 *     classify: (err) => (isAuthError(err) ? 'fatal' : 'item'),
 *     onProgress: ({ done, failed, total }) => report(done / total)
 *   })
 */
export interface FanoutOptions<T> {
  /** plural noun for log lines and warnings, e.g. 'image captions' */
  label: string
  /** default 16 */
  concurrency?: number
  /** 'fatal' stops the whole run; default: every error is the item's own */
  classify?: (error: unknown) => 'fatal' | 'item'
  /** consecutive failures that stop the run; default 10 */
  maxStreak?: number
  /** failure share that stops the run once `minSample` items finished; default 0.5 */
  maxFailureRate?: number
  /** default 40 */
  minSample?: number
  /** failure share that produces a warning; default 0.02 */
  warnRate?: number
  /** failure count above which there is always a warning; default 20 */
  warnCount?: number
  /** external cancellation */
  signal?: AbortSignal
  /** checked before each item starts (e.g. a pause file exists) */
  paused?: () => boolean
  /** short name of an item for log lines */
  describe?: (item: T) => string
  /** called once per failed (non-fatal) item, e.g. to record it for a later retry */
  onFailure?: (item: T, error: unknown) => void
  onProgress?: (progress: FanoutProgress) => void
  /** default console.warn */
  log?: (line: string) => void
}

export interface FanoutProgress {
  done: number
  failed: number
  total: number
}

export interface FanoutResult<R> {
  /** one entry per input item, `undefined` where the item failed */
  results: Array<R | undefined>
  failed: number
  /** items never started because `paused()` returned true */
  paused: number
  /** user-facing summary when failures passed the soft threshold */
  warning?: string
}

export class FanoutAbortedError extends Error {
  override name = 'FanoutAbortedError'
  constructor(
    message: string,
    readonly progress: FanoutProgress,
    options?: { cause?: unknown }
  ) {
    super(message, options)
  }
}

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/gu, ' ').slice(0, 160)
}

export async function fanout<T, R>(
  items: readonly T[],
  run: (item: T, context: { index: number; signal: AbortSignal }) => Promise<R>,
  options: FanoutOptions<T>
): Promise<FanoutResult<R>> {
  const {
    label,
    concurrency = 16,
    classify = () => 'item',
    maxStreak = 10,
    maxFailureRate = 0.5,
    minSample = 40,
    warnRate = 0.02,
    warnCount = 20,
    log = (line: string) => console.warn(line)
  } = options
  const total = items.length
  const results: Array<R | undefined> = Array.from({ length: total })
  let done = 0
  let failed = 0
  let paused = 0
  let streak = 0
  const controller = new AbortController()
  const stop = (message: string, cause: unknown) => {
    if (!controller.signal.aborted)
      controller.abort(
        new FanoutAbortedError(
          `${label}: ${message}`,
          { done, failed, total },
          { cause }
        )
      )
  }
  const onOuterAbort = () => stop('cancelled', options.signal?.reason)
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  if (options.signal?.aborted) onOuterAbort()

  try {
    await pMap(
      items,
      async (item, index) => {
        if (paused || options.paused?.()) {
          paused++
          return
        }
        try {
          results[index] = await run(item, { index, signal: controller.signal })
          streak = 0
        } catch (err) {
          if (controller.signal.aborted) return
          if (classify(err) === 'fatal') return stop(errorText(err), err)
          failed++
          streak++
          const name = options.describe?.(item) ?? `#${index}`
          log(`[murmuration] ${label}: skipped ${name}: ${errorText(err)}`)
          options.onFailure?.(item, err)
          if (streak >= maxStreak)
            stop(`${streak} failures in a row (last: ${errorText(err)})`, err)
        } finally {
          if (!controller.signal.aborted) {
            done++
            if (done >= minSample && failed / done > maxFailureRate)
              stop(`${failed} of ${done} failed`, undefined)
            options.onProgress?.({ done, failed, total })
          }
        }
      },
      { concurrency, signal: controller.signal }
    )
  } catch (err) {
    throw controller.signal.reason instanceof FanoutAbortedError
      ? controller.signal.reason
      : err
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
  if (controller.signal.aborted) throw controller.signal.reason

  const warning =
    failed > 0 &&
    (failed >= Math.max(1, warnRate * total) || failed > warnCount)
      ? `${failed.toLocaleString()} of ${total.toLocaleString()} ${label} failed; they'll be retried on the next rebuild.`
      : undefined
  return { results, failed, paused, warning }
}
