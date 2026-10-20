import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
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
const PIPELINE_REVISION = 3

interface CacheMeta {
  version: number
  revision: number
  fingerprint: DbFingerprint
  generatedAt: string
}

const sameFingerprint = (a: DbFingerprint, b: DbFingerprint) =>
  a.path === b.path && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1

/**
 * Builds the dataset once, keeps the gzipped JSON in memory, and mirrors it
 * to `.cache/` so restarts are instant. Only derived data is written; the
 * Birdclaw database is opened read-only.
 */
export class DatasetStore {
  private gz: Buffer | undefined
  private meta: CacheMeta | undefined
  private building: Promise<void> | undefined
  progress: BuildProgress = { phase: 'Waiting', fraction: 0, done: false }

  constructor(private readonly cacheDir: string) {}

  private get dataPath() {
    return path.join(this.cacheDir, 'dataset.json.gz')
  }

  private get metaPath() {
    return path.join(this.cacheDir, 'dataset.meta.json')
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

  ensure(force = false): Promise<void> {
    if (this.building) return this.building
    if (!force && this.gz) return Promise.resolve()
    if (!force && this.loadFromDisk()) return Promise.resolve()
    this.building = this.build().finally(() => {
      this.building = undefined
    })
    return this.building
  }

  private loadFromDisk(): boolean {
    try {
      const meta = JSON.parse(readFileSync(this.metaPath, 'utf8')) as CacheMeta
      const current = fingerprintDb(resolveDbPath())
      if (
        meta.version !== DATASET_VERSION ||
        meta.revision !== PIPELINE_REVISION
      )
        return false
      if (!sameFingerprint(meta.fingerprint, current)) return false
      this.gz = readFileSync(this.dataPath)
      this.meta = meta
      this.progress = { phase: 'Ready', fraction: 1, done: true }
      return true
    } catch {
      return false
    }
  }

  private async build() {
    this.progress = { phase: 'Starting', fraction: 0, done: false }
    try {
      const fingerprint = fingerprintDb(resolveDbPath())
      const dataset: Dataset = await buildDataset((phase, fraction) => {
        this.progress = { phase, fraction, done: false }
      })
      this.progress = { phase: 'Compressing', fraction: 1, done: false }
      const gz = gzipSync(JSON.stringify(dataset), { level: 6 })
      const meta: CacheMeta = {
        version: DATASET_VERSION,
        revision: PIPELINE_REVISION,
        fingerprint,
        generatedAt: dataset.meta.generatedAt
      }
      mkdirSync(this.cacheDir, { recursive: true })
      writeFileSync(`${this.dataPath}.tmp`, gz)
      renameSync(`${this.dataPath}.tmp`, this.dataPath)
      writeFileSync(this.metaPath, JSON.stringify(meta, null, 2))
      this.gz = gz
      this.meta = meta
      this.progress = { phase: 'Ready', fraction: 1, done: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.progress = {
        phase: 'Failed',
        fraction: 0,
        done: true,
        error: message
      }
      console.error('[murmuration] dataset build failed:', err)
    }
  }
}
