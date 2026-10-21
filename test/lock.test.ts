import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assertLocked, lockFile, withBuildLock } from '../src/server/lock'

const repo = path.resolve(import.meta.dirname, '..')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'murmuration-lock-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A separate Node process that takes the lock, logs, and holds it for `holdMs`. */
function holder(log: string, holdMs: number): ChildProcess {
  const script = path.join(dir, 'holder.mjs')
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { withBuildLock } from ${JSON.stringify(pathToFileURL(path.join(repo, 'src/server/lock.ts')).href)}
const [dir, log, hold] = process.argv.slice(2)
await withBuildLock(dir, async () => {
  appendFileSync(log, 'start ' + process.pid + '\\n')
  await sleep(Number(hold))
  appendFileSync(log, 'end ' + process.pid + '\\n')
}, { pollMs: 10, onWait: () => appendFileSync(log, 'wait ' + process.pid + '\\n') })
`
  )
  return spawn(
    process.execPath,
    ['--import', 'tsx', script, path.join(dir, 'cache'), log, String(holdMs)],
    { cwd: repo, stdio: 'ignore' }
  )
}

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => child.once('exit', () => resolve()))

const readLog = (log: string) =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []

async function until(check: () => boolean, timeoutMs = 10_000) {
  const t0 = performance.now()
  while (!check()) {
    if (performance.now() - t0 > timeoutMs) throw new Error('timed out')
    await sleep(10)
  }
}

describe('build lock', () => {
  it('serializes holders in different processes', async () => {
    const log = path.join(dir, 'log')
    const a = holder(log, 600)
    await until(() => readLog(log).length > 0)
    const b = holder(log, 50)
    await Promise.all([exited(a), exited(b)])
    expect(readLog(log)).toEqual([
      `start ${a.pid}`,
      `wait ${b.pid}`,
      `end ${a.pid}`,
      `start ${b.pid}`,
      `end ${b.pid}`
    ])
    expect(existsSync(lockFile(path.join(dir, 'cache')))).toBe(false)
  }, 20_000)

  it('reclaims a lock left by a process that died holding it', async () => {
    const log = path.join(dir, 'log')
    const child = holder(log, 60_000)
    await until(() => readLog(log).length > 0)
    child.kill('SIGKILL')
    await exited(child)
    const cache = path.join(dir, 'cache')
    expect(readFileSync(lockFile(cache), 'utf8')).toMatch(
      new RegExp(`^${child.pid} `)
    )

    let waitedFor: number | undefined
    const t0 = performance.now()
    const waited = await withBuildLock(cache, async (_, w) => w, {
      onWait: (pid) => (waitedFor = pid)
    })
    expect(waited).toBe(false)
    expect(waitedFor).toBeUndefined()
    expect(performance.now() - t0).toBeLessThan(500)
    expect(existsSync(lockFile(cache))).toBe(false)
  }, 20_000)

  it('makes a second build in this process wait, and lets it cancel the wait', async () => {
    let release!: () => void
    const first = withBuildLock(
      dir,
      () => new Promise<void>((resolve) => (release = resolve))
    )
    await until(() => existsSync(lockFile(dir)))

    const controller = new AbortController()
    const waits: number[] = []
    const second = withBuildLock(dir, async () => 'ran', {
      signal: controller.signal,
      pollMs: 10,
      onWait: (pid) => waits.push(pid)
    })
    await sleep(50)
    controller.abort(new Error('restarting'))
    await expect(second).rejects.toThrow('restarting')
    expect(waits).toEqual([process.pid])

    // A third one gets the lock as soon as the first lets go.
    const third = withBuildLock(dir, async (_, waited) => waited, {
      pollMs: 10
    })
    release()
    await first
    expect(await third).toBe(true)
  })

  it('refuses to take the lock again from inside the build holding it', async () => {
    await withBuildLock(dir, async (lock) => {
      assertLocked(lock, dir)
      await expect(withBuildLock(dir, async () => {})).rejects.toThrow(
        /already held by this build/
      )
    })
  })

  it('only vouches for a lock that is still held', async () => {
    let kept: Parameters<typeof assertLocked>[0]
    await withBuildLock(dir, async (lock) => {
      kept = lock
      expect(() => assertLocked(lock, path.join(dir, 'other'))).toThrow(
        /need the build lock/
      )
    })
    expect(() => assertLocked(kept, dir)).toThrow(/need the build lock/)
    expect(() => assertLocked(undefined, dir)).toThrow(/need the build lock/)
  })
})
