#!/usr/bin/env -S pnpm exec tsx
// Drives the built murmuration site headlessly and keeps the evidence.
//
//   pnpm exec tsx .agents/skills/verify-murmuration/verify.ts doctor
//   pnpm exec tsx .agents/skills/verify-murmuration/verify.ts list
//   pnpm exec tsx .agents/skills/verify-murmuration/verify.ts run <journey…> [--out <dir>]
//
// `run` serves dist/ with its own `vite preview` on a free port, runs each
// journey (journeys/<name>.ts) in a fresh Chromium context, and writes steps,
// screenshots, ARIA snapshots and console/network problems to
// .cache/verify/<run>/<journey>/. It stops the server and browser it started,
// even on failure; the evidence stays.
import { execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { chromium, type Page } from 'playwright'

import {
  launchBrowser,
  openPage,
  openView,
  root,
  servePreview,
  type ViewId
} from '../../../scripts/lib/browser'

export interface Verify {
  page: Page
  /** origin of the preview server, e.g. http://127.0.0.1:53123 */
  base: string
  /** opens a view by URL and waits for its panel and particle morph */
  open: (view: ViewId) => Promise<void>
  /** records a user action or observation in steps.md */
  step: (text: string) => void
  /** fails the journey with a message when the condition is false */
  check: (ok: boolean, message: string) => void
  /** JPEG screenshot of the page; returns its path */
  shot: (name: string) => Promise<string>
  /** ARIA snapshot of the page (roles, names, text); returns its path */
  aria: (name: string) => Promise<string>
}

const here = import.meta.dirname
const journeysDir = path.join(here, 'journeys')
const journeys = () =>
  readdirSync(journeysDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3))
    .sort()

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' } }
})
const [command = 'doctor', ...names] = positionals

if (command === 'list') {
  console.log(journeys().join('\n'))
} else if (command === 'doctor') {
  process.exitCode = doctor() ? 0 : 1
} else if (command === 'run') {
  process.exitCode = (await run(names.length ? names : journeys())) ? 0 : 1
} else {
  console.error(`Unknown command "${command}": use doctor, list or run.`)
  process.exitCode = 2
}

/** Read-only: is there a current build of the real export to drive? */
function doctor(): boolean {
  let ok = true
  const line = (pass: boolean, text: string) => {
    console.log(`${pass ? '✓' : '✗'} ${text}`)
    if (!pass) ok = false
  }
  const exportFile = path.join(root, 'data', 'dataset.json')
  const html = path.join(root, 'dist', 'index.html')
  line(
    Number(process.versions.node.split('.')[0]) >= 24,
    `Node ${process.versions.node} (needs 24+)`
  )
  line(
    existsSync(exportFile),
    existsSync(exportFile)
      ? `export: data/dataset.json from ${exportedAt(exportFile)}`
      : 'export: data/dataset.json missing (run `pnpm export --plan`, then `pnpm export`)'
  )
  if (!existsSync(html)) line(false, 'build: dist/ missing (run `pnpm build`)')
  else {
    const built = statSync(html).mtimeMs
    const newer = newestSource()
    line(
      newer.mtimeMs <= built,
      newer.mtimeMs <= built
        ? `build: dist/ is newer than every source file`
        : `build: dist/ is older than ${path.relative(root, newer.file)} (run \`pnpm build\`)`
    )
  }
  line(
    existsSync(chromium.executablePath()),
    `browser: Playwright Chromium ${existsSync(chromium.executablePath()) ? 'installed' : 'missing (run `pnpm exec playwright install chromium`)'}`
  )
  try {
    const head = execSync('git rev-parse --short HEAD', { cwd: root })
      .toString()
      .trim()
    const dirty = execSync('git status --porcelain', { cwd: root })
      .toString()
      .trim()
    console.log(
      `· git ${head}${dirty ? ' with uncommitted changes (build them first)' : ''}`
    )
  } catch {
    // not a git checkout
  }
  return ok
}

function exportedAt(file: string) {
  const text = readFileSync(file, 'utf8')
  return /"exportedAt":"([^"]+)"/.exec(text)?.[1]?.slice(0, 10) ?? 'unknown'
}

function newestSource() {
  let newest = { file: '', mtimeMs: 0 }
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else {
        const { mtimeMs } = statSync(file)
        if (mtimeMs > newest.mtimeMs) newest = { file, mtimeMs }
      }
    }
  }
  for (const dir of ['src', 'public']) visit(path.join(root, dir))
  for (const file of ['index.html', 'vite.config.ts', 'data/dataset.json']) {
    const { mtimeMs } = statSync(path.join(root, file))
    if (mtimeMs > newest.mtimeMs) newest = { file: path.join(root, file), mtimeMs }
  }
  return newest
}

async function run(names: string[]): Promise<boolean> {
  const missing = names.filter((n) => !journeys().includes(n))
  if (missing.length) {
    console.error(`No such journey: ${missing.join(', ')} (see \`list\`)`)
    return false
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outRoot = path.resolve(
    args.out ?? path.join(root, '.cache', 'verify', stamp)
  )
  const server = await servePreview()
  console.log(`preview ${server.url} (pid ${server.pid}) · evidence ${outRoot}`)
  const browser = await launchBrowser()
  let passed = 0
  try {
    for (const name of names) {
      const out = path.join(outRoot, name)
      mkdirSync(out, { recursive: true })
      const steps: string[] = []
      const failures: string[] = []
      const { page, problems } = await openPage(browser)
      const v: Verify = {
        page,
        base: server.url,
        open: (view) => openView(page, server.url, view),
        step: (text) => {
          steps.push(`- ${text}`)
          console.log(`  · ${text}`)
        },
        check: (ok, message) => {
          if (!ok) throw new Error(message)
        },
        shot: async (shotName) => {
          const file = path.join(out, `${shotName}.jpg`)
          await page.screenshot({ path: file, type: 'jpeg', quality: 70 })
          steps.push(`  - screenshot: ${shotName}.jpg`)
          return file
        },
        aria: async (snapName) => {
          const file = path.join(out, `${snapName}.aria.yml`)
          writeFileSync(file, await page.locator('body').ariaSnapshot())
          steps.push(`  - ARIA snapshot: ${snapName}.aria.yml`)
          return file
        }
      }
      console.log(`▸ ${name}`)
      try {
        const journey = (await import(path.join(journeysDir, `${name}.ts`)))
          .default as (v: Verify) => Promise<void>
        await journey(v)
      } catch (err) {
        failures.push(err instanceof Error ? err.message.split('\n')[0]! : String(err))
        await v.shot('failure').catch(() => {})
      }
      failures.push(
        ...problems.console.map((m) => `console: ${m}`),
        ...problems.requests.map((m) => `request: ${m}`)
      )
      await page.context().close()
      writeFileSync(
        path.join(out, 'steps.md'),
        [
          `# ${name}: ${failures.length ? 'FAIL' : 'PASS'}`,
          '',
          ...steps,
          ...(failures.length ? ['', '## Failures', '', ...failures.map((f) => `- ${f}`)] : []),
          ''
        ].join('\n')
      )
      console.log(
        failures.length
          ? `✗ ${name}\n${failures.map((f) => `    ${f}`).join('\n')}`
          : `✓ ${name}`
      )
      if (!failures.length) passed++
    }
  } finally {
    await browser.close()
    server.stop()
  }
  console.log(`\n${passed}/${names.length} journeys passed · evidence in ${outRoot}`)
  return passed === names.length
}
