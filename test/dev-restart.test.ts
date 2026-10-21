import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { createServer, type ViteDevServer } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'

import { lockFile } from '../src/server/lock'

// `pnpm dev` loads vite.config.ts with the module runner, so every file it
// imports (all of src/server/) is a config dependency: editing one restarts
// the server and re-creates the plugin. This drives a real dev server through
// such a restart and checks that the old plugin's build is cancelled.

const repo = path.resolve(import.meta.dirname, '..')
let root: string | undefined
let server: ViteDevServer | undefined
let http: Server | undefined

afterEach(async () => {
  await server?.close()
  http?.close()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('cancels the build when a config dependency restarts the dev server', async () => {
  // Real path: imports resolve from it (macOS's tmpdir is a symlink).
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'murmuration-dev-')))
  // No archive and no key: nothing here may read ~/.birdclaw or call OpenAI.
  vi.stubEnv('BIRDCLAW_DB', path.join(root, 'missing.sqlite'))
  vi.stubEnv('OPENAI_API_KEY', '')
  const plugins = path.join(root, 'plugins.ts')
  const plugin = path.relative(root, path.join(repo, 'src/server/plugin.ts'))
  writeFileSync(
    plugins,
    `export { murmurationData } from ${JSON.stringify(plugin)}\n`
  )
  writeFileSync(
    path.join(root, 'vite.config.ts'),
    `import { murmurationData } from './plugins'
export default {
  plugins: [murmurationData()],
  appType: 'custom',
  logLevel: 'silent',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, ws: false }
}
`
  )
  // This test holds the build lock, so the plugin's build sits waiting for
  // it (cancellably) instead of reading an archive.
  mkdirSync(path.join(root, '.cache'))
  writeFileSync(lockFile(path.join(root, '.cache')), `${process.pid} test`)

  const cancelled: string[] = []
  const warn = console.warn.bind(console)
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('dataset build cancelled'))
      cancelled.push(String(args[0]))
    else warn(...args)
  })

  server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    configLoader: 'runner'
  })
  expect(server.config.configFileDependencies).toEqual(
    expect.arrayContaining([
      plugins,
      path.join(repo, 'src/server/plugin.ts'),
      path.join(repo, 'src/server/cache.ts')
    ])
  )
  // The middleware stack survives restarts, so this keeps working.
  http = createHttpServer(server.middlewares).listen(0)
  await new Promise((resolve) => http!.once('listening', resolve))
  const status = async () => {
    const { port } = http!.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/status`)
    return (await res.json()) as { phase: string; done: boolean }
  }
  expect(await status()).toMatchObject({
    phase: 'Waiting for the previous build to stop',
    done: false
  })

  // Edit the config dependency until the watcher picks it up; a restart
  // swaps in the new server's config. Each edit can restart (and cancel)
  // again, so give a restart up to 2 s before editing once more: under load
  // a 100 ms cadence lands a second edit mid-restart.
  const before = server.config
  for (let attempt = 0; server.config === before; attempt++) {
    if (attempt === 10) throw new Error('the dev server never restarted')
    appendFileSync(plugins, '// edited\n')
    for (let t = 0; t < 20 && server.config === before; t++) await sleep(100)
  }
  await vi.waitFor(() => expect(cancelled.length).toBeGreaterThan(0))
  const restarts = cancelled.length
  // The restarted server's own build is the only one left, still waiting.
  expect(await status()).toMatchObject({
    phase: 'Waiting for the previous build to stop',
    done: false
  })

  // Closing the server cancels that one, too.
  await server.close()
  server = undefined
  await vi.waitFor(() => expect(cancelled).toHaveLength(restarts + 1))
}, 30_000)
