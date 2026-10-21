import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { PIPELINE_REVISION } from '../src/server/cache'
import { EXPORT_FORMAT, toPublicDataset } from '../src/server/publicExport'
import { fixture } from './fixtures/dataset'

// Runs the real production build (vite.config.ts + the murmuration plugin)
// against a synthetic export, so the publish path is checked without an archive.

const root = path.resolve(import.meta.dirname, '..')
let dir = ''
let out = ''
let exported = Buffer.alloc(0)

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'murmuration-build-'))
  out = path.join(dir, 'dist')
  exported = Buffer.from(
    JSON.stringify({
      ...toPublicDataset(fixture()),
      export: {
        format: EXPORT_FORMAT,
        exportedAt: '2026-01-01T00:00:00.000Z',
        revision: PIPELINE_REVISION,
        source: { size: 0, mtimeMs: 0 },
        audit: {
          messages: 0,
          fingerprinted: 0,
          publicOverlap: 0,
          sharedPhrases: 0,
          strings: 0,
          chars: 0,
          leaks: []
        }
      }
    })
  )
  const exportFile = path.join(dir, 'dataset.json')
  writeFileSync(exportFile, exported)
  // The fixture never matches the local archive; that warning is expected.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  process.env.MURMURATION_EXPORT = exportFile
  try {
    await build({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      configLoader: 'runner',
      logLevel: 'silent',
      build: { outDir: out, emptyOutDir: true }
    })
  } finally {
    delete process.env.MURMURATION_EXPORT
    warn.mockRestore()
  }
}, 120_000)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const read = (file: string) => readFileSync(path.join(out, file), 'utf8')

describe('production build', () => {
  it('publishes the export under a content-hashed name, byte for byte', () => {
    const files = readdirSync(path.join(out, 'data'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^dataset\.[0-9a-f]{12}\.json$/)
    expect(
      readFileSync(path.join(out, 'data', files[0]!)).equals(exported)
    ).toBe(true)
    const html = read('index.html')
    expect(html).toContain(`href="/data/${files[0]}"`)
    expect(read('llms.txt')).toContain(`/data/${files[0]}`)
  })

  it('hashes code and styles so they can be cached as immutable', () => {
    for (const file of readdirSync(path.join(out, 'assets')))
      expect(file).toMatch(/-[\w-]{8,}\.(js|css)$/)
  })

  it('writes page metadata, structured data and crawler files', () => {
    const html = read('index.html')
    expect(html).toContain('<title>Me (@me) on X, in 3D · Murmuration</title>')
    expect(html).toMatch(
      /<meta property="og:image" content="https:\/\/[^"]+\/og\.jpg">/
    )
    expect(html).toContain('<meta name="murmuration:analytics" content="{}">')
    const ld = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(
      html
    )
    expect(JSON.parse(ld![1]!)['@graph']).toHaveLength(5)
    expect(read('robots.txt')).toContain('Sitemap: ')
    expect(read('sitemap.xml')).toContain('<loc>')
    expect(read('llms.txt')).toMatch(/^# Murmuration/)
  })
})
