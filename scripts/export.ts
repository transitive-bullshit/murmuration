// Exports the publishable dataset to data/dataset.json. `pnpm build` (and so
// any deploy) requires it, and the dev server serves it when it exists.
//
//   1. reads your Birdclaw archive (read-only)
//   2. captions images and embeds every tweet: OpenAI when OPENAI_API_KEY is
//      set (in .env or the environment), else a local model. Both are cached
//      per tweet in .cache/, so only new tweets cost anything, and a build
//      that would pay for more than the spend caps stops unless --yes.
//   3. runs the analytics: topics, map, growth, inflections, relationships
//   4. copies only allowlisted fields and audits the result against your DMs
//      (their text is never read into the dataset; counts per person are kept)
//
//   pnpm export                   # reuse .cache when the archive hasn't changed
//   pnpm export --plan            # print the paid requests a build would make; make none
//   pnpm export --yes             # pay for them even above the spend caps
//   pnpm export --force           # re-run the analytics (embeddings stay cached)
//   pnpm export --allow-fallback  # publish even if the configured embedder failed

import os from 'node:os'
import path from 'node:path'

import { DatasetStore, preferredEmbedder } from '../src/server/cache'
import { planDataset } from '../src/server/dataset'
import { fingerprintDb, resolveDbPath } from '../src/server/db'
import { loadLocalEnv } from '../src/server/env'
import { EXPORT_FILE, runExport } from '../src/server/exporter'
import { describeWork, holdReason, spendCaps } from '../src/server/paid'
import { LEAK_RUN } from '../src/server/publicExport'

const root = path.resolve(import.meta.dirname, '..')
const cacheDir = path.join(root, '.cache')
loadLocalEnv(root)
const force = process.argv.includes('--force')
const allowFallback = process.argv.includes('--allow-fallback')
const yes = process.argv.includes('--yes')

const tty = process.stdout.isTTY
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s)
const fmt = (n: number) => n.toLocaleString('en-US')
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`
const elapsed = (ms: number) =>
  ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
const line = (s: string) =>
  process.stdout.write(tty ? `\r\x1b[2K${s}\n` : `${s}\n`)
const row = (label: string, value: string) =>
  line(`${label.padEnd(12)}${value}`)

const dbPath = resolveDbPath()
let archive
try {
  archive = fingerprintDb(dbPath)
} catch {
  console.error(
    `No Birdclaw archive at ${dbPath}. Import one with \`birdclaw import archive <x-archive.zip>\`, or set BIRDCLAW_DB.`
  )
  process.exit(1)
}
row(
  'Archive',
  `${dbPath.replace(os.homedir(), '~')} · ${mb(archive.size)} · modified ${new Date(archive.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`
)
row(
  'Embeddings',
  preferredEmbedder() === 'openai'
    ? 'OpenAI, with image captions (OPENAI_API_KEY is set)'
    : 'local model (set OPENAI_API_KEY in .env for OpenAI embeddings and image captions)'
)
line('')

// The paid requests a build would make (only uncached items), and what
// `pnpm export` would do about them. Requests nothing.
if (process.argv.includes('--plan')) {
  const plan = await planDataset({ cacheDir })
  const caps = spendCaps()
  if (!plan.paid) {
    row(
      'Plan',
      `nothing paid · ${fmt(plan.embeddings)} tweets to embed with the local ${plan.embeddingModel}`
    )
    process.exit(0)
  }
  row(
    'Plan',
    `${describeWork(plan)} from OpenAI (${[plan.captionModel, plan.embeddingModel].filter(Boolean).join(', ')})`
  )
  row(
    'Limit',
    `${fmt(caps.captions)} captions and ${fmt(caps.embeddings)} embeddings per build (MURMURATION_MAX_NEW_CAPTIONS, MURMURATION_MAX_NEW_EMBEDDINGS)`
  )
  const held = holdReason(plan, 'strict', cacheDir, caps)
  row(
    'Next',
    held === 'pause'
      ? '.cache/PAUSE exists: nothing is requested until it is deleted'
      : held === 'cap'
        ? 'over the limit: `pnpm export` stops, `pnpm export --yes` pays for it'
        : plan.captions || plan.embeddings
          ? 'under the limit: `pnpm export` pays for it'
          : 'everything is cached'
  )
  process.exit(0)
}

// One line per pipeline step, with a live percentage on terminals.
const EXPORT_STEPS = new Set([
  'Removing private data',
  'Checking for DM content',
  'Writing the export'
])
let step: { name: string; t0: number } | undefined
let built = false
const finishStep = () => {
  if (step)
    line(
      `  ✓ ${step.name.padEnd(36)}${dim(elapsed(performance.now() - step.t0))}`
    )
  step = undefined
}
const onProgress = (phase: string, fraction: number) => {
  const name = phase.replace(/\s*\(.*\)$/u, '')
  if (step?.name !== name) {
    finishStep()
    if (!EXPORT_STEPS.has(name)) built = true
    else if (!built) {
      line(
        `  ✓ ${'Analytics are current in .cache'.padEnd(36)}${dim('--force to rebuild')}`
      )
      built = true
    }
    step = { name, t0: performance.now() }
  }
  if (tty)
    process.stdout.write(
      `\r\x1b[2K  · ${phase} ${dim(`${Math.round(fraction * 100)}%`)}`
    )
}

try {
  const store = new DatasetStore(cacheDir)
  const result = await runExport({
    root,
    store,
    force,
    allowFallback,
    spend: yes ? 'approved' : 'strict',
    onProgress
  })
  finishStep()
  line('')
  const { meta, people } = result.dataset
  const { audit } = result.manifest
  const { embedding: e } = meta
  row(
    'Embedded',
    `${e.provider} · ${e.model} · ${e.dims}d${e.captions ? ` · ${fmt(e.captions)} tweets with image captions` : ''}`
  )
  if (e.missing)
    row(
      'Missing',
      `${fmt(e.missing)} tweets got no vector this time (${fmt(e.imputed)} placed by their nearest neighbors); re-run \`pnpm export\` to retry them`
    )
  const dmPeople = people.dmIn.filter((n, i) => n + people.dmOut[i]! > 0).length
  row(
    'Kept',
    `${fmt(meta.counts.mine)} tweets · ${fmt(meta.counts.likes)} likes · ${fmt(meta.counts.bookmarks)} bookmarks · DM counts for ${fmt(dmPeople)} people`
  )
  row(
    'Removed',
    'all DM text (the analytics only count DMs) · the archive path'
  )
  row(
    'Audited',
    `${fmt(audit.messages)} DMs (${fmt(audit.fingerprinted)} long enough to fingerprint) against ${fmt(audit.strings)} exported strings: no DM text${audit.sharedPhrases ? ` (${fmt(audit.sharedPhrases)} with a short phrase in common, under ${LEAK_RUN} characters)` : ''}`
  )
  for (const w of result.warnings) row('Warning', w)
  row(
    result.unchanged ? 'Unchanged' : 'Wrote',
    `${EXPORT_FILE} · ${mb(result.bytes)} (${mb(result.gzipBytes)} gzipped)${result.unchanged ? ` · same data as the ${result.manifest.exportedAt.slice(0, 10)} export, so its URL and visitors' caches stay valid` : ''}`
  )
  row(
    'Next',
    '`pnpm build` publishes it to dist/ (see contributing.md to deploy)'
  )
} catch (err) {
  line('')
  console.error(
    `Export failed: ${err instanceof Error ? err.message : String(err)}`
  )
  process.exit(1)
}
