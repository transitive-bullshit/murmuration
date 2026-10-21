// Shared Playwright plumbing for scripts/smoke.ts and scripts/shots.ts: serve
// the production build (dist/), open views in headless Chromium, collect
// errors, and measure the WebGL canvas.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

import { chromium, type Browser, type Page } from 'playwright'
import sharp from 'sharp'

import { VIEWS, type ViewId } from '../../src/client/views'

export const root = path.resolve(import.meta.dirname, '../..')
export { VIEWS, type ViewId }

/** Analytics only exists on Vercel; locally its script 404s by design. */
const EXPECTED_MISSING = /\/_vercel\//

export interface Server {
  url: string
  /** the `vite preview` process; stop() kills only this one */
  pid: number
  stop: () => void
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/** `vite preview` of dist/ on a free port; stop() kills only that process. */
export async function servePreview(): Promise<Server> {
  if (!existsSync(path.join(root, 'dist', 'index.html')))
    throw new Error('No build in dist/: run `pnpm build` first.')
  const port = await freePort()
  const child = spawn(
    path.join(root, 'node_modules', '.bin', 'vite'),
    [
      'preview',
      '--configLoader',
      'runner',
      '--port',
      String(port),
      '--strictPort',
      '--host',
      '127.0.0.1'
    ],
    { cwd: root, stdio: 'ignore' }
  )
  const stop = () => {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  process.once('exit', stop)
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return { url, pid: child.pid!, stop }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  stop()
  throw new Error(`vite preview did not start on ${url}`)
}

/** Headless Chromium with a real GPU path where the platform has one. */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    args:
      process.platform === 'darwin'
        ? ['--use-angle=metal', '--ignore-gpu-blocklist']
        : ['--ignore-gpu-blocklist']
  })
}

export interface Problems {
  console: string[]
  requests: string[]
}

/**
 * A page sized like a laptop screen, with the first-visit controls guide and
 * media previews (images from X) turned off, recording console errors and
 * failed requests.
 */
export async function openPage(
  browser: Browser,
  options: { width?: number; height?: number; scale?: number } = {}
): Promise<{ page: Page; problems: Problems }> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    deviceScaleFactor: options.scale ?? 1
  })
  await context.addInitScript(() => {
    localStorage.setItem('murmuration:controls-seen', '1')
    localStorage.setItem('murmuration:mediaPreviews', 'false')
  })
  const page = await context.newPage()
  const problems: Problems = { console: [], requests: [] }
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const where = msg.location().url
    if (EXPECTED_MISSING.test(where) || EXPECTED_MISSING.test(msg.text()))
      return
    // Resource 404s also surface as console errors; keep them with the request.
    if (msg.text().startsWith('Failed to load resource')) return
    problems.console.push(msg.text())
  })
  page.on('pageerror', (err) => problems.console.push(err.message))
  page.on('response', (res) => {
    if (res.status() >= 400 && !EXPECTED_MISSING.test(res.url()))
      problems.requests.push(`${res.status()} ${res.url()}`)
  })
  page.on('requestfailed', (req) => {
    if (!EXPECTED_MISSING.test(req.url()))
      problems.requests.push(`${req.failure()?.errorText} ${req.url()}`)
  })
  return { page, problems }
}

/** Opens a view by its URL and waits for its panel and the particle morph. */
export async function openView(page: Page, base: string, view: ViewId) {
  const label = VIEWS.find((v) => v.id === view)!.label
  await page.goto(`${base}/${view}`)
  await page.locator('canvas').waitFor({ timeout: 60_000 })
  await page
    .locator('aside')
    .filter({ hasText: label })
    .first()
    .waitFor({ timeout: 60_000 })
  // Layout morphs take ~2.6 s; auto-rotation only starts after 8 s idle.
  await page.waitForTimeout(3500)
}

/** CSS that hides every DOM layer above the canvas (panels, labels, header). */
export const HIDE_UI = `
  #root > div > div:nth-child(2) { display: none !important; }
  canvas ~ div { display: none !important; }
`

/**
 * How much of the WebGL canvas is lit, measured with the UI hidden. A NaN in
 * a shader blacks out the whole frame under the half-float composer, so a
 * near-zero share means a broken render.
 */
export async function canvasHealth(page: Page) {
  const style = await page.addStyleTag({ content: HIDE_UI })
  await page.waitForTimeout(100)
  const png = await page.locator('canvas').screenshot({ type: 'png' })
  await style.evaluate((el) => (el as Element).remove())
  const { data, info } = await sharp(png)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let lit = 0
  for (const v of data) if (v > 40) lit++
  return { lit: lit / (info.width * info.height) }
}
