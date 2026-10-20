import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

import {
  DATASET_VERSION,
  type BuildProgress,
  type Dataset
} from '../shared/types'
import {
  PIPELINE_REVISION,
  preferredEmbedder,
  type DatasetStore
} from './cache'
import { fingerprintDb, openReadOnly, resolveDbPath } from './db'
import {
  DmFingerprints,
  EXPORT_FORMAT,
  auditExport,
  toPublicDataset,
  type DmAudit,
  type ExportManifest,
  type PublicExport
} from './publicExport'

/** Where `pnpm export` writes the snapshot, relative to the project root. */
export const EXPORT_FILE = 'data/dataset.json'
export const exportPath = (root: string) => path.join(root, EXPORT_FILE)

export interface ExportOptions {
  root: string
  store: DatasetStore
  /** rebuild the analytics even if the archive hasn't changed (captions and vectors stay cached) */
  force?: boolean
  /** publish even if the preferred embedder failed and a fallback ran */
  allowFallback?: boolean
  onProgress?: (phase: string, fraction: number) => void
}

export interface ExportResult {
  file: string
  bytes: number
  gzipBytes: number
  dataset: Dataset
  manifest: ExportManifest
  /** notes about a degraded build (not published) */
  warnings: string[]
}

/**
 * The export pipeline:
 *
 *   1. read the archive, caption images, embed every tweet, run the analytics
 *      (`buildDataset`; captions and vectors are cached per tweet in .cache/)
 *   2. insist on the embedder you configured (OpenAI with OPENAI_API_KEY,
 *      else the local model) rather than silently publishing a fallback
 *   3. copy only allowlisted fields (`toPublicDataset`)
 *   4. audit every exported string against your DMs and secrets
 *   5. write data/dataset.json atomically
 */
export async function runExport(options: ExportOptions): Promise<ExportResult> {
  const { root, store } = options
  const report = options.onProgress ?? (() => {})
  const unwatch = store.watch((p) => !p.done && report(p.phase, p.fraction))
  try {
    await store.ensure(options.force)
  } finally {
    unwatch()
  }
  const { error } = store.status()
  if (error) throw new Error(error)
  const source = store.fingerprint()
  if (!source) throw new Error('The analytics build produced no dataset')
  const dataset = JSON.parse(
    gunzipSync(await store.get()).toString('utf8')
  ) as Dataset

  const want = preferredEmbedder()
  const got = dataset.meta.embedding.provider
  if (got !== want && !options.allowFallback)
    throw new Error(
      `Embeddings fell back to "${got}" instead of ${want === 'openai' ? 'OpenAI' : 'the local model'}; see the warnings above. Fix that and re-run, or pass --allow-fallback to publish anyway.`
    )

  report('Removing private data', 0)
  const data = toPublicDataset(dataset)

  report('Checking for DM content', 0)
  const audit = auditPrivateContent(data)
  if (audit.leaks.length)
    throw new Error(
      `Export blocked: private content found in ${audit.leaks.join('; ')}`
    )

  report('Writing the export', 0)
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    revision: PIPELINE_REVISION,
    source: { size: source.size, mtimeMs: source.mtimeMs },
    audit
  }
  const json = Buffer.from(
    JSON.stringify({ ...data, export: manifest } satisfies PublicExport)
  )
  const file = exportPath(root)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, json)
  renameSync(tmp, file)
  return {
    file,
    bytes: json.byteLength,
    gzipBytes: gzipSync(json, { level: 6 }).byteLength,
    dataset: data,
    manifest,
    warnings: dataset.meta.warnings ?? []
  }
}

/**
 * Fingerprints every DM in the archive (read-only; the text is hashed here
 * and nowhere else), marks passages that are public anyway (tweets,
 * including long-form note text), then scans the export for DM text, the
 * archive path, and your OpenAI key.
 */
export function auditPrivateContent(
  data: Dataset,
  dbPath = resolveDbPath()
): DmAudit {
  const dms = new DmFingerprints()
  const db = openReadOnly(dbPath)
  try {
    for (const row of db.prepare('select text from dm_messages').iterate())
      dms.addMessage(typeof row.text === 'string' ? row.text : '')
    for (const row of db
      .prepare('select text, note_tweet_json from tweets')
      .iterate()) {
      if (typeof row.text === 'string') dms.addPublic(row.text)
      if (typeof row.note_tweet_json === 'string')
        for (const s of jsonStrings(row.note_tweet_json)) dms.addPublic(s)
    }
  } finally {
    db.close()
  }
  const key = process.env.OPENAI_API_KEY
  return auditExport(data, dms, [
    { label: 'the archive path', value: dbPath },
    ...(key ? [{ label: 'OPENAI_API_KEY', value: key }] : [])
  ])
}

function jsonStrings(json: string): string[] {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  try {
    walk(JSON.parse(json))
  } catch {
    // not JSON; nothing to add
  }
  return out
}

interface ExportFile {
  raw: Buffer
  manifest: ExportManifest
}

function readExport(file: string): ExportFile {
  const raw = readFileSync(file)
  const data = JSON.parse(raw.toString('utf8')) as Partial<PublicExport>
  if (
    data.export?.format !== EXPORT_FORMAT ||
    data.meta?.version !== DATASET_VERSION
  )
    throw new Error(
      `${EXPORT_FILE} was made by another version of murmuration; re-run \`pnpm export\``
    )
  return { raw, manifest: data.export }
}

/** Why an export no longer reflects your archive and pipeline, if it doesn't. */
export function staleReason(manifest: ExportManifest): string | undefined {
  if (manifest.revision !== PIPELINE_REVISION)
    return 'the analytics have changed since it was made'
  try {
    const fp = fingerprintDb(resolveDbPath())
    if (
      fp.size !== manifest.source.size ||
      Math.abs(fp.mtimeMs - manifest.source.mtimeMs) >= 1
    )
      return 'your Birdclaw archive has changed since it was made'
  } catch {
    // no archive on this machine (e.g. a CI or cloud build); nothing to compare
  }
  return undefined
}

/** For production builds: the export to publish, or an error saying how to make one. */
export function requireExport(root: string): ExportFile & { file: string } {
  const file = exportPath(root)
  try {
    statSync(file)
  } catch {
    throw new Error(
      `No data export at ${EXPORT_FILE}. Production builds publish a static snapshot of your archive: run \`pnpm export\` (reads ~/.birdclaw read-only, strips DM text), then build again.`
    )
  }
  return { file, ...readExport(file) }
}

const READY: BuildProgress = { phase: 'Ready', fraction: 1, done: true }

/**
 * The dev server's view of data/dataset.json: serves it when it exists and
 * matches this version of the app, and re-runs the export on request.
 */
export class ExportStore {
  private gz: Buffer | undefined
  private manifest: ExportManifest | undefined
  private loadedMtime = -1
  private running: Promise<void> | undefined
  progress: BuildProgress = READY

  constructor(
    private readonly root: string,
    private readonly store: DatasetStore
  ) {}

  /** Whether there's a usable export (re-checked when the file changes). */
  available(): boolean {
    return !!this.running || this.load()
  }

  private load(): boolean {
    const file = exportPath(this.root)
    let mtimeMs: number
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      this.loadedMtime = -1
      this.gz = this.manifest = undefined
      return false
    }
    if (mtimeMs === this.loadedMtime) return !!this.gz
    this.loadedMtime = mtimeMs
    try {
      const { raw, manifest } = readExport(file)
      this.manifest = manifest
      this.gz = gzipSync(raw, { level: 6 })
    } catch (err) {
      this.gz = this.manifest = undefined
      console.warn(
        `[murmuration] ignoring ${EXPORT_FILE}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return !!this.gz
  }

  status() {
    this.load()
    return {
      ...this.progress,
      ready: !this.running && !!this.gz,
      stale: !this.running && !!this.manifest && !!staleReason(this.manifest),
      generatedAt: this.manifest?.exportedAt,
      source: 'export' as const
    }
  }

  get(): Buffer {
    if (!this.load() || !this.gz) throw new Error(`${EXPORT_FILE} is missing`)
    return this.gz
  }

  /** Re-exports from the archive; the current export is served until it's done. */
  rebuild() {
    this.running ??= runExport({
      root: this.root,
      store: this.store,
      onProgress: (phase, fraction) => {
        this.progress = { phase, fraction, done: false }
      }
    })
      .then(() => {
        this.progress = READY
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.progress = {
          phase: 'Failed',
          fraction: 0,
          done: true,
          error: message
        }
        console.error('[murmuration] export failed:', err)
      })
      .finally(() => {
        this.running = undefined
      })
  }
}
