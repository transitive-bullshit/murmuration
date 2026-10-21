import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { errorText, fanout, type FanoutProgress } from '../fanout'

// Image captions, cached per media URL in an append-only JSONL file so an
// interrupted (cancelled, paused) run resumes where it stopped. Images are
// captioned several per request; if a group fails, its images are retried
// one per request so one bad image can't sink its neighbors. Failed images
// are recorded and retried on later runs after a growing cooldown, not on
// every rebuild. Images that no longer exist (deleted on X) are expected:
// they're recorded as gone, never requested again, and don't count as
// failures.

export type Captioner = (url: string, signal?: AbortSignal) => Promise<string>
export type BatchCaptioner = (
  urls: string[],
  signal?: AbortSignal
) => Promise<string[]>

export interface CaptionOptions {
  /** JSONL cache file */
  file: string
  captioner: Captioner
  /** optional multi-image captioner; used for groups of `groupSize` */
  batchCaptioner?: BatchCaptioner
  groupSize?: number
  /** 'fatal' (bad key, missing model) stops the run; anything else is the image's problem */
  classify?: (err: unknown) => 'fatal' | 'item'
  /** checked after an image's request fails: true when the image itself is gone */
  gone?: (url: string, signal?: AbortSignal) => Promise<boolean>
  concurrency?: number
  now?: () => number
  /** request nothing and return what's cached (the build held paid work back) */
  cachedOnly?: boolean
  /** checked before each request; once true, no new request starts */
  paused?: () => boolean
  /** cancels the run: in-flight requests are aborted, finished captions kept */
  signal?: AbortSignal
  onProgress?: (progress: FanoutProgress) => void
  log?: (line: string) => void
}

export interface CaptionResult {
  /** every cached caption for the given URLs, including earlier runs' */
  captions: Map<string, string>
  /** images requested in this run */
  requested: number
  failed: number
  /** images that no longer exist, recorded so they're never requested again */
  missing: number
  /** images left unrequested because `paused()` turned true */
  paused: number
  /** user-facing note when many images failed */
  warning?: string
  /** set when the run stopped early (bad key, service unreachable) */
  error?: unknown
}

const Line = z.object({
  url: z.string(),
  caption: z.string().optional(),
  error: z.string().optional(),
  gone: z.boolean().optional(),
  at: z.number().optional(),
  attempts: z.number().int().optional()
})
type Line = z.infer<typeof Line>

const MAX_ATTEMPTS = 4
const COOLDOWN_MS = 6 * 3600_000

function readLines(file: string): { latest: Map<string, Line>; lines: number } {
  const latest = new Map<string, Line>()
  if (!existsSync(file)) return { latest, lines: 0 }
  let lines = 0
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue
    lines++
    try {
      const line = Line.parse(JSON.parse(raw))
      latest.set(line.url, line)
    } catch {
      // torn or foreign line: ignore
    }
  }
  return { latest, lines }
}

function due(line: Line | undefined, now: number): boolean {
  if (!line) return true
  if (line.caption || line.gone) return false
  const attempts = line.attempts ?? 1
  return (
    attempts < MAX_ATTEMPTS &&
    now - (line.at ?? 0) >= COOLDOWN_MS * 2 ** (attempts - 1)
  )
}

const uniqueUrls = (urls: readonly string[]) => [
  ...new Set(urls.filter(Boolean))
]

function cachedCaptions(
  latest: Map<string, Line>,
  urls: readonly string[]
): Map<string, string> {
  const captions = new Map<string, string>()
  for (const url of urls) {
    const caption = latest.get(url)?.caption
    if (caption) captions.set(url, caption)
  }
  return captions
}

/**
 * What `captionImages` would request for `urls` (uncached images, and failed
 * ones whose cooldown is over), plus the captions already cached. Reads the
 * cache only.
 */
export function planCaptions(
  urls: readonly string[],
  options: { file: string; now?: () => number }
): { todo: string[]; captions: Map<string, string> } {
  const { latest } = readLines(options.file)
  const now = (options.now ?? Date.now)()
  const unique = uniqueUrls(urls)
  return {
    todo: unique.filter((url) => due(latest.get(url), now)),
    captions: cachedCaptions(latest, unique)
  }
}

/** Whether an image is gone for good (404 or 410), e.g. media deleted on X. */
export async function imageGone(
  url: string,
  signal?: AbortSignal
): Promise<boolean> {
  const timeout = AbortSignal.timeout(10_000)
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    return res.status === 404 || res.status === 410
  } catch {
    return false
  }
}

export async function captionImages(
  urls: readonly string[],
  options: CaptionOptions
): Promise<CaptionResult> {
  const now = options.now ?? Date.now
  const classify = options.classify ?? (() => 'item')
  const log = options.log ?? ((line: string) => console.warn(line))
  const { latest, lines } = readLines(options.file)
  const unique = uniqueUrls(urls)
  const todo = options.cachedOnly
    ? []
    : unique.filter((url) => due(latest.get(url), now()))
  if (!options.cachedOnly) {
    await mkdir(path.dirname(options.file), { recursive: true })
    if (lines > latest.size * 1.5 + 100) {
      const tmp = `${options.file}.${process.pid}.tmp`
      await writeFile(
        tmp,
        [...latest.values()].map((l) => `${JSON.stringify(l)}\n`).join('')
      )
      await rename(tmp, options.file)
    }
  }

  let writes = Promise.resolve()
  const record = (line: Line) => {
    latest.set(line.url, line)
    writes = writes.then(() =>
      appendFile(options.file, `${JSON.stringify(line)}\n`)
    )
  }
  const fatal = (err: unknown) => classify(err) === 'fatal'

  let imagesDone = 0
  let imagesFailed = 0
  let imagesMissing = 0
  const succeed = (url: string, caption: string) => {
    if (!caption) return fail(url, new Error('empty caption'))
    record({ url, caption })
    return true
  }
  const fail = (url: string, err: unknown) => {
    imagesFailed++
    log(`[murmuration] image captions: skipped ${url}: ${errorText(err)}`)
    record({
      url,
      error: errorText(err),
      at: now(),
      attempts: (latest.get(url)?.attempts ?? 0) + 1
    })
    return false
  }
  const missing = (url: string) => {
    imagesMissing++
    record({ url, gone: true, at: now() })
    return true
  }
  const single = async (url: string, signal: AbortSignal) => {
    try {
      return succeed(url, await options.captioner(url, signal))
    } catch (err) {
      if (fatal(err) || signal.aborted) throw err
      const gone = await options.gone?.(url, signal)
      if (signal.aborted) throw err
      return gone ? missing(url) : fail(url, err)
    }
  }

  const size = options.batchCaptioner ? Math.max(1, options.groupSize ?? 8) : 1
  const groups: string[][] = []
  for (let i = 0; i < todo.length; i += size)
    groups.push(todo.slice(i, i + size))

  let error: unknown
  let paused = 0
  try {
    const run = await fanout(
      groups,
      async (group, { signal }) => {
        let ok = 0
        try {
          let captions: string[] | undefined
          if (options.batchCaptioner && group.length > 1) {
            try {
              captions = await options.batchCaptioner(group, signal)
            } catch (err) {
              if (fatal(err) || signal.aborted) throw err
            }
          }
          if (captions) {
            for (const [i, url] of group.entries())
              if (succeed(url, captions[i] ?? '')) ok++
          } else {
            const results = await Promise.all(
              group.map((url) => single(url, signal))
            )
            ok = results.filter(Boolean).length
          }
        } finally {
          imagesDone += group.length
        }
        // A group where every image failed (none captioned or gone) counts
        // against the error budget.
        if (!ok) throw new Error(`all ${group.length} images failed`)
      },
      {
        label: 'image caption groups',
        concurrency: options.concurrency ?? 16,
        classify: (err) => (fatal(err) ? 'fatal' : 'item'),
        signal: options.signal,
        paused: options.paused,
        // Individual images were already logged above.
        log: () => {},
        onProgress: () =>
          options.onProgress?.({
            done: imagesDone,
            failed: imagesFailed,
            total: todo.length
          })
      }
    )
    if (run.paused) paused = todo.length - imagesDone
  } catch (err) {
    error = err
  }
  await writes
  if (imagesMissing)
    log(
      `[murmuration] image captions: skipped ${imagesMissing.toLocaleString()} images that no longer exist`
    )

  const warning =
    imagesFailed > 20 ||
    (imagesFailed > 0 && imagesFailed >= 0.02 * todo.length)
      ? `${imagesFailed.toLocaleString()} of ${todo.length.toLocaleString()} images couldn't be described; they'll be retried on a later rebuild.`
      : undefined
  return {
    captions: cachedCaptions(latest, unique),
    requested: todo.length,
    failed: imagesFailed,
    missing: imagesMissing,
    paused,
    warning,
    error
  }
}
