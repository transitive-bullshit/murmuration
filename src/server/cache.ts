import { randomUUID } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  DATASET_VERSION,
  type BuildProgress,
  type Dataset
} from '../shared/types'
import { buildDataset } from './dataset'
import { fingerprintDb, resolveDbPath, type DbFingerprint } from './db'

// Bump when analytics change in a way that should invalidate cached builds.
export const PIPELINE_REVISION = 5

/** The embedder a build should use: OpenAI when a key is configured. */
export function preferredEmbedder(): 'openai' | 'local' {
  return process.env.OPENAI_API_KEY ? 'openai' : 'local'
}

interface CacheMeta {
  version: number
  revision: number
  /**
   * The embedder the build actually used. A build that fell back (or a key
   * added or removed since) isn't reused, so the preferred one is retried.
   */
  embedder: string
  fingerprint: DbFingerprint
  generatedAt: string
}

const sameFingerprint = (a: DbFingerprint, b: DbFingerprint) =>
  a.path === b.path && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1

/** Whether a build still reflects this code, configuration, and archive. */
function isFresh(meta: CacheMeta): boolean {
  try {
    return (
      meta.version === DATASET_VERSION &&
      meta.revision === PIPELINE_REVISION &&
      meta.embedder === preferredEmbedder() &&
      sameFingerprint(meta.fingerprint, fingerprintDb(resolveDbPath()))
    )
  } catch {
    return false
  }
}

/**
 * Builds the dataset once, keeps the gzipped JSON in memory, and mirrors it
 * to `.cache/` so restarts are instant. Only derived data is written; the
 * Birdclaw database is opened read-only.
 */
export class DatasetStore {
  private gz: Buffer | undefined
  private meta: CacheMeta | undefined
  private building: Promise<void> | undefined
  private readonly listeners = new Set<(p: BuildProgress) => void>()
  progress: BuildProgress = { phase: 'Waiting', fraction: 0, done: false }

  constructor(private readonly cacheDir: string) {}

  private get dataPath() {
    return path.join(this.cacheDir, 'dataset.json.gz')
  }

  private get metaPath() {
    return path.join(this.cacheDir, 'dataset.meta.json')
  }

  /** Calls `fn` on every progress update until the returned function is called. */
  watch(fn: (p: BuildProgress) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private setProgress(progress: BuildProgress) {
    this.progress = progress
    for (const fn of this.listeners) fn(progress)
  }

  /** The archive the current dataset was built from. */
  fingerprint(): DbFingerprint | undefined {
    return this.meta?.fingerprint
  }

  status() {
    let stale = false
    try {
      if (this.meta)
        stale = !sameFingerprint(
          this.meta.fingerprint,
          fingerprintDb(resolveDbPath())
        )
    } catch {}
    return {
      ...this.progress,
      ready: !!this.gz,
      stale,
      generatedAt: this.meta?.generatedAt
    }
  }

  /** Returns the gzipped dataset, building it if needed. */
  async get(): Promise<Buffer> {
    if (this.gz) return this.gz
    await this.ensure()
    if (!this.gz) throw new Error(this.progress.error ?? 'Dataset build failed')
    return this.gz
  }

  /** Builds unless a fresh dataset is in memory or on disk (or `force`). */
  ensure(force = false): Promise<void> {
    if (this.building) return this.building
    if (!force && this.gz && this.meta && isFresh(this.meta))
      return Promise.resolve()
    if (!force && this.loadFromDisk()) return Promise.resolve()
    this.building = this.build().finally(() => {
      this.building = undefined
    })
    return this.building
  }

  private loadFromDisk(): boolean {
    try {
      const meta = JSON.parse(readFileSync(this.metaPath, 'utf8')) as CacheMeta
      if (!isFresh(meta)) return false
      this.gz = readFileSync(this.dataPath)
      this.meta = meta
      this.setProgress({ phase: 'Ready', fraction: 1, done: true })
      return true
    } catch {
      return false
    }
  }

  private async build() {
    this.setProgress({ phase: 'Starting', fraction: 0, done: false })
    try {
      await withBuildLock(
        this.cacheDir,
        (pid) =>
          this.setProgress({
            phase: `Waiting for another build to finish (pid ${pid}; if none is running, delete .cache/build.lock)`,
            fraction: 0,
            done: false
          }),
        async (waited) => {
          // Whoever held the lock may have just built exactly this.
          if (waited && this.loadFromDisk()) return
          const fingerprint = fingerprintDb(resolveDbPath())
          const dataset: Dataset = await buildDataset((phase, fraction) => {
            this.setProgress({ phase, fraction, done: false })
          })
          this.setProgress({ phase: 'Compressing', fraction: 1, done: false })
          const gz = gzipSync(JSON.stringify(dataset), { level: 6 })
          const meta: CacheMeta = {
            version: DATASET_VERSION,
            revision: PIPELINE_REVISION,
            embedder: dataset.meta.embedding.provider,
            fingerprint,
            generatedAt: dataset.meta.generatedAt
          }
          mkdirSync(this.cacheDir, { recursive: true })
          const tmp = `${this.dataPath}.${randomUUID()}.tmp`
          writeFileSync(tmp, gz)
          renameSync(tmp, this.dataPath)
          writeFileSync(this.metaPath, JSON.stringify(meta, null, 2))
          this.gz = gz
          this.meta = meta
        }
      )
      this.setProgress({ phase: 'Ready', fraction: 1, done: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setProgress({
        phase: 'Failed',
        fraction: 0,
        done: true,
        error: message
      })
      console.error('[murmuration] dataset build failed:', err)
    }
  }
}

/**
 * One build at a time per cache directory, across processes (`pnpm export`
 * next to `pnpm dev`) and across Vite restarts within one: concurrent builds
 * would pay for the same embeddings twice and race on the vector cache.
 */
async function withBuildLock(
  cacheDir: string,
  onWait: (pid: number) => void,
  fn: (waited: boolean) => Promise<void>
) {
  const file = path.join(cacheDir, 'build.lock')
  const token = `${process.pid} ${randomUUID()}`
  mkdirSync(cacheDir, { recursive: true })
  let waited = false
  for (;;) {
    const holder = tryLock(file, token)
    if (holder === undefined) break
    if (!waited && holder > 0) onWait(holder)
    waited = true
    await new Promise((r) => setTimeout(r, 1000))
  }
  try {
    await fn(waited)
  } finally {
    // Only ever remove our own lock.
    try {
      if (readFileSync(file, 'utf8') === token) rmSync(file)
    } catch {
      // already gone
    }
  }
}

/**
 * Takes the lock, or returns the pid holding it (0 while it's mid-write).
 * A lock whose owner died is moved aside atomically and checked before
 * it's discarded, so a lock someone else just took is never deleted.
 */
function tryLock(file: string, token: string): number | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, token, { flag: 'wx' })
      return undefined
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const pid = lockOwner(file)
    if (pid === undefined) return 0
    if (isAlive(pid)) return pid
    const aside = `${file}.${randomUUID()}`
    try {
      renameSync(file, aside)
    } catch {
      return 0 // someone else moved it first
    }
    if (lockOwner(aside) === pid) rmSync(aside, { force: true })
    else {
      // A new owner took the lock between our check and the move: put it
      // back, unless yet another process has taken it meanwhile.
      try {
        linkSync(aside, file)
      } catch {
        // can't restore without clobbering; the next holder keeps it
      }
      rmSync(aside, { force: true })
      return 0
    }
  }
  return 0
}

function lockOwner(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, 'utf8').split(' ')[0])
    return pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: alive, but someone else's process.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
