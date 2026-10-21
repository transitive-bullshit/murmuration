import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  DATASET_VERSION,
  type BuildProgress,
  type Dataset,
  type HeldWork
} from '../shared/types'
import { buildDataset } from './dataset'
import { fingerprintDb, resolveDbPath, type DbFingerprint } from './db'
import { waitingPhase, withBuildLock } from './lock'
import { SpendHeldError, stillHeld, type SpendPolicy } from './paid'

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
  /** paid work the build left for later (see paid.ts) */
  held?: HeldWork
}

const sameFingerprint = (a: DbFingerprint, b: DbFingerprint) =>
  a.path === b.path && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1

/** Whether a build still reflects this code, configuration, and archive. */
function isFresh(
  meta: CacheMeta,
  spend: SpendPolicy,
  cacheDir: string
): boolean {
  try {
    if (
      meta.version !== DATASET_VERSION ||
      meta.revision !== PIPELINE_REVISION ||
      !sameFingerprint(meta.fingerprint, fingerprintDb(resolveDbPath()))
    )
      return false
    // A build that left paid work for later stands in only for another
    // capped build, and only while that work would still be held back.
    if (meta.held)
      return (
        spend === 'capped' &&
        preferredEmbedder() === 'openai' &&
        stillHeld(meta.held, cacheDir)
      )
    return meta.embedder === preferredEmbedder()
  } catch {
    return false
  }
}

export interface EnsureOptions {
  /** rebuild even if a fresh dataset exists */
  force?: boolean
  /** what to do with paid work over the caps or while paused; default 'capped' */
  spend?: SpendPolicy
}

/**
 * Builds the dataset once, keeps the gzipped JSON in memory, and mirrors it
 * to `.cache/` so restarts are instant. Only derived data is written; the
 * Birdclaw database is opened read-only. Builds hold the build lock, so one
 * runs at a time per cache directory, across processes; `abort()` stops one.
 */
export class DatasetStore {
  private gz: Buffer | undefined
  private meta: CacheMeta | undefined
  private building: Promise<void> | undefined
  private controller: AbortController | undefined
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
        stale =
          !sameFingerprint(
            this.meta.fingerprint,
            fingerprintDb(resolveDbPath())
          ) ||
          // e.g. .cache/PAUSE was deleted: a rebuild would carry on
          (!!this.meta.held && !stillHeld(this.meta.held, this.cacheDir))
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
  ensure({
    force = false,
    spend = 'capped'
  }: EnsureOptions = {}): Promise<void> {
    if (this.building) return this.building
    if (
      !force &&
      this.gz &&
      this.meta &&
      isFresh(this.meta, spend, this.cacheDir)
    )
      return Promise.resolve()
    if (!force && this.loadFromDisk(spend)) return Promise.resolve()
    this.building = this.build(spend).finally(() => {
      this.building = undefined
    })
    return this.building
  }

  /**
   * Cancels the build in progress, if any: its requests are aborted, and
   * whatever they finished stays cached for the next build.
   */
  abort() {
    this.controller?.abort(new Error('The build was cancelled'))
  }

  private loadFromDisk(spend: SpendPolicy): boolean {
    try {
      const meta = JSON.parse(readFileSync(this.metaPath, 'utf8')) as CacheMeta
      if (!isFresh(meta, spend, this.cacheDir)) return false
      this.gz = readFileSync(this.dataPath)
      this.meta = meta
      this.setProgress({ phase: 'Ready', fraction: 1, done: true })
      return true
    } catch {
      return false
    }
  }

  private async build(spend: SpendPolicy) {
    const controller = new AbortController()
    const { signal } = controller
    this.controller = controller
    this.setProgress({ phase: 'Starting', fraction: 0, done: false })
    try {
      await withBuildLock(
        this.cacheDir,
        async (lock, waited) => {
          // Whoever held the lock may have just built exactly this.
          if (waited && this.loadFromDisk(spend)) return
          const fingerprint = fingerprintDb(resolveDbPath())
          const dataset: Dataset = await buildDataset({
            cacheDir: this.cacheDir,
            lock,
            signal,
            spend,
            onProgress: (phase, fraction) => {
              this.setProgress({ phase, fraction, done: false })
            }
          })
          this.setProgress({ phase: 'Compressing', fraction: 1, done: false })
          const gz = gzipSync(JSON.stringify(dataset), { level: 6 })
          const meta: CacheMeta = {
            version: DATASET_VERSION,
            revision: PIPELINE_REVISION,
            embedder: dataset.meta.embedding.provider,
            fingerprint,
            generatedAt: dataset.meta.generatedAt,
            ...(dataset.meta.held && { held: dataset.meta.held })
          }
          mkdirSync(this.cacheDir, { recursive: true })
          const tmp = `${this.dataPath}.${randomUUID()}.tmp`
          writeFileSync(tmp, gz)
          renameSync(tmp, this.dataPath)
          writeFileSync(this.metaPath, JSON.stringify(meta, null, 2))
          this.gz = gz
          this.meta = meta
        },
        {
          signal,
          onWait: (pid) =>
            this.setProgress({
              phase: waitingPhase(pid),
              fraction: 0,
              done: false
            })
        }
      )
      this.setProgress({ phase: 'Ready', fraction: 1, done: true })
    } catch (err) {
      if (signal.aborted) {
        console.warn('[murmuration] dataset build cancelled')
        this.setProgress({
          phase: 'Cancelled',
          fraction: 0,
          done: true,
          error: 'The build was cancelled'
        })
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      this.setProgress({
        phase: 'Failed',
        fraction: 0,
        done: true,
        error: message
      })
      // Held paid work isn't a crash; whoever asked for the build reports it.
      if (!(err instanceof SpendHeldError))
        console.error('[murmuration] dataset build failed:', err)
    } finally {
      if (this.controller === controller) this.controller = undefined
    }
  }
}
