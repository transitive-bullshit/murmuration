// Headless smoke test of the production build: serves dist/ and opens every
// view in Chromium, failing on console errors, failed requests, a missing
// view panel, or a blank WebGL canvas (e.g. a NaN in a shader). Saves a DPR-1
// JPEG of each view as evidence.
//
//   pnpm smoke                    # builds first; screenshots in .cache/smoke/
//   tsx scripts/smoke.ts --out <dir> [--view strata]
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import {
  VIEWS,
  canvasHealth,
  launchBrowser,
  openPage,
  openView,
  root,
  servePreview,
  type ViewId
} from './lib/browser'

// Lit share of the canvas below which a view counts as blank. Healthy views
// measure ~1–15%; a NaN-blacked frame measures ~0.
const MIN_LIT = 0.002

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(root, '.cache', 'smoke') },
    view: { type: 'string', multiple: true }
  }
})
const outDir = path.resolve(args.out!)
const views = (
  args.view?.length ? args.view : VIEWS.map((v) => v.id)
) as ViewId[]
mkdirSync(outDir, { recursive: true })

const server = await servePreview()
const browser = await launchBrowser()
let failed = 0
try {
  const { page, problems } = await openPage(browser)
  for (const view of views) {
    const before = {
      console: problems.console.length,
      requests: problems.requests.length
    }
    const issues: string[] = []
    try {
      await openView(page, server.url, view)
      const { lit } = await canvasHealth(page)
      if (lit < MIN_LIT)
        issues.push(`canvas looks blank (${(lit * 100).toFixed(2)}% lit)`)
      const shot = path.join(outDir, `${view}.jpg`)
      await page.screenshot({ path: shot, type: 'jpeg', quality: 70 })
      issues.push(
        ...problems.console.slice(before.console).map((m) => `console: ${m}`),
        ...problems.requests.slice(before.requests).map((m) => `request: ${m}`)
      )
      console.log(
        `${issues.length ? '✗' : '✓'} ${view.padEnd(13)} ${(lit * 100).toFixed(1).padStart(5)}% lit  ${path.relative(root, shot)}`
      )
    } catch (err) {
      issues.push(
        err instanceof Error ? err.message.split('\n')[0]! : String(err)
      )
      console.log(`✗ ${view}`)
    }
    for (const issue of issues) console.log(`    ${issue}`)
    if (issues.length) failed++
  }
} finally {
  await browser.close()
  server.stop()
}
console.log(
  failed
    ? `\n${failed} of ${views.length} views failed`
    : `\nAll ${views.length} views rendered cleanly`
)
process.exitCode = failed ? 1 : 0
