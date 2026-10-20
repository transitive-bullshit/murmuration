import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ANALYTICS_META } from '../src/server/site'

const script = path.resolve(
  import.meta.dirname,
  '../scripts/vercel-analytics.mjs'
)

/** Runs the Vercel-side build step on a page; returns the meta's decoded value. */
function fill(html: string, config?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'murmuration-deploy-'))
  try {
    const file = path.join(dir, 'index.html')
    writeFileSync(file, html)
    execFileSync('node', [script, file], {
      env: { ...process.env, VERCEL_OBSERVABILITY_CLIENT_CONFIG: config },
      stdio: 'pipe'
    })
    const content = /content="([^"]*)"/.exec(readFileSync(file, 'utf8'))![1]!
    return content.replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code))
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// What Vite writes for the tag from headTags().
const page = `<html><head><meta name="${ANALYTICS_META}" content="{}"></head></html>`

describe('vercel-analytics.mjs', () => {
  it("writes Vercel's analytics config into the page, intact", () => {
    const config = JSON.stringify({
      analytics: {
        scriptSrc: '05eb0a4568339f0e/script.js',
        viewEndpoint: '05eb0a4568339f0e/view'
      },
      note: `quotes " and <tags> & 'apostrophes'`
    })
    expect(fill(page, config)).toBe(config)
  })

  it('leaves the defaults without a config', () => {
    expect(fill(page)).toBe('{}')
  })

  it('fails loudly when the page has no placeholder', () => {
    expect(() => fill('<html></html>')).toThrow()
  })
})
