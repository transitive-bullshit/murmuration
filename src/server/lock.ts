import { AsyncLocalStorage } from 'node:async_hooks'
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
import { setTimeout as sleep } from 'node:timers/promises'

// The build lock: one build at a time per cache directory, across processes
// (`pnpm export` next to `pnpm dev`) and within one (a dev-server restart
// starts a new build while the old one winds down). Concurrent builds would
// pay for the same captions and embeddings twice and race on their caches.
// This module only depends on Node built-ins, so tests can load it in child
// processes.

/** Proof that this process holds the build lock for a cache directory. */
export interface BuildLock {
  readonly file: string
  /** whether the lock file still names this holder */
  held(): boolean
}

export interface LockOptions {
  /** stops waiting for the lock (rejects with the signal's reason) */
  signal?: AbortSignal
  /** called once if another live process holds the lock */
  onWait?: (pid: number) => void
  /** default 250 */
  pollMs?: number
}

export const lockFile = (cacheDir: string) =>
  path.resolve(cacheDir, 'build.lock')

/** Progress label while another build holds the lock. */
export const waitingPhase = (pid: number) =>
  pid === process.pid
    ? 'Waiting for the previous build to stop'
    : `Waiting for another build to finish (pid ${pid}; if none is running, delete .cache/build.lock)`

// Locks held by the current async call chain: taking one again from inside
// would wait on itself forever, so that throws instead.
const holding = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * Runs `fn` while holding `<cacheDir>/build.lock`, waiting while another live
 * process (or another build in this one) holds it. A lock left by a dead
 * process is reclaimed. `waited` tells `fn` that another build ran first, so
 * it may have just produced what `fn` was about to.
 */
export async function withBuildLock<T>(
  cacheDir: string,
  fn: (lock: BuildLock, waited: boolean) => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const file = lockFile(cacheDir)
  const outer = holding.getStore()
  if (outer?.has(file))
    throw new Error(
      `${file} is already held by this build; pass its lock along instead of taking it again`
    )
  const token = `${process.pid} ${randomUUID()}`
  mkdirSync(cacheDir, { recursive: true })
  let waited = false
  for (;;) {
    options.signal?.throwIfAborted()
    const holder = tryLock(file, token)
    if (holder === undefined) break
    if (!waited && holder > 0) options.onWait?.(holder)
    waited = true
    // Rejects only when aborted; rethrow the signal's own reason.
    await sleep(options.pollMs ?? 250, undefined, {
      signal: options.signal
    }).catch(() => options.signal?.throwIfAborted())
  }
  const lock: BuildLock = { file, held: () => readToken(file) === token }
  try {
    return await holding.run(new Set([...(outer ?? []), file]), () =>
      fn(lock, waited)
    )
  } finally {
    // Only ever remove our own lock.
    if (lock.held()) rmSync(file, { force: true })
  }
}

/** Throws unless `lock` is the build lock of `cacheDir`, held right now. */
export function assertLocked(
  lock: BuildLock | undefined,
  cacheDir: string
): asserts lock is BuildLock {
  const file = lockFile(cacheDir)
  if (!lock || lock.file !== file || !lock.held())
    throw new Error(
      `Paid requests need the build lock (${file}): go through buildDataset() or withBuildLock()`
    )
}

function readToken(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
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
  const pid = Number(readToken(file)?.split(' ')[0])
  return pid > 0 ? pid : undefined
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
