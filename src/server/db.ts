import { statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function resolveDbPath(): string {
  const fromEnv = process.env.BIRDCLAW_DB
  if (fromEnv) return path.resolve(fromEnv.replace(/^~(?=$|\/)/, os.homedir()))
  return path.join(os.homedir(), '.birdclaw', 'birdclaw.sqlite')
}

export interface DbFingerprint {
  path: string
  size: number
  mtimeMs: number
}

export function fingerprintDb(dbPath = resolveDbPath()): DbFingerprint {
  // WAL writes land in the -wal sidecar before checkpointing, so include it.
  const main = statSync(dbPath)
  let size = main.size
  let mtimeMs = main.mtimeMs
  try {
    const wal = statSync(`${dbPath}-wal`)
    size += wal.size
    mtimeMs = Math.max(mtimeMs, wal.mtimeMs)
  } catch {}
  return { path: dbPath, size, mtimeMs }
}

/**
 * Opens the Birdclaw store strictly read-only. Falls back to SQLite's
 * `immutable` mode when the WAL shared-memory file can't be created (e.g. in
 * a sandbox); that mode never touches the directory at all.
 */
export function openReadOnly(dbPath = resolveDbPath()): DatabaseSync {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    db.prepare('select 1').get()
    return db
  } catch {
    const url = new URL(`file://${dbPath}`)
    url.searchParams.set('immutable', '1')
    return new DatabaseSync(url, { readOnly: true })
  }
}
