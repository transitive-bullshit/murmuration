import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Dataset, HeldWork } from '../src/shared/types'
import { DatasetStore } from '../src/server/cache'
import { buildDataset, type BuildOptions } from '../src/server/dataset'
import { assertLocked, lockFile } from '../src/server/lock'
import { pauseFile } from '../src/server/paid'

// The store's own logic, with the pipeline stubbed out: no archive is read
// and nothing is requested.
vi.mock('../src/server/dataset', () => ({
  buildDataset: vi.fn<typeof buildDataset>()
}))
const build = vi.mocked(buildDataset)

const fakeDataset = (held?: HeldWork) =>
  ({
    meta: {
      generatedAt: new Date().toISOString(),
      embedding: { provider: 'openai' },
      ...(held && { held })
    }
  }) as Dataset

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'murmuration-store-'))
  const db = path.join(dir, 'birdclaw.sqlite')
  writeFileSync(db, '')
  vi.stubEnv('BIRDCLAW_DB', db)
  // Only read to decide which embedder a cached build should have used.
  vi.stubEnv('OPENAI_API_KEY', 'not-a-key')
  build.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('DatasetStore', () => {
  it('builds under the lock, and abort() cancels the build', async () => {
    let options: BuildOptions | undefined
    build.mockImplementation(
      (o) =>
        new Promise((_, reject) => {
          options = o
          o!.signal!.addEventListener('abort', () => reject(o!.signal!.reason))
        })
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new DatasetStore(dir)
    const done = store.ensure()
    await vi.waitFor(() => expect(options).toBeDefined())
    // The store passes its lock along rather than having the build take it again.
    expect(() => assertLocked(options!.lock, dir)).not.toThrow()
    expect(options!.spend).toBe('capped')

    store.abort()
    await done
    expect(store.status()).toMatchObject({
      phase: 'Cancelled',
      done: true,
      ready: false,
      error: 'The build was cancelled'
    })
    expect(existsSync(lockFile(dir))).toBe(false)
  })

  it('reuses a build that held paid work back only for capped builds, while it is still held', async () => {
    const held: HeldWork = { reason: 'pause', captions: 3, embeddings: 4 }
    build.mockResolvedValue(fakeDataset(held))
    writeFileSync(pauseFile(dir), '')

    await new DatasetStore(dir).ensure()
    expect(build).toHaveBeenCalledTimes(1)

    // A restarted dev server takes it from disk while the pause lasts...
    const dev = new DatasetStore(dir)
    await dev.ensure()
    expect(build).toHaveBeenCalledTimes(1)
    expect(dev.status()).toMatchObject({ ready: true, stale: false })

    // ...but an export never publishes it.
    build.mockResolvedValue(fakeDataset())
    await new DatasetStore(dir).ensure({ spend: 'strict' })
    expect(build).toHaveBeenCalledTimes(2)
    expect(build.mock.calls[1]![0]!.spend).toBe('strict')

    // Deleting the pause file lets the next build carry on.
    build.mockResolvedValue(fakeDataset(held))
    const paused = new DatasetStore(dir)
    await paused.ensure({ force: true })
    rmSync(pauseFile(dir))
    expect(paused.status().stale).toBe(true)
    await new DatasetStore(dir).ensure()
    expect(build).toHaveBeenCalledTimes(4)
  })
})
