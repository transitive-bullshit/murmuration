// Builds (or refreshes) the derived analytics cache from your Birdclaw
// archive without starting the app, and prints a short summary.
//
//   pnpm analyze            # build if the archive changed
//   pnpm analyze --force    # always rebuild
//   pnpm analyze --yes      # pay for OpenAI work above the spend caps (see `pnpm export --plan`)

import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import type { Dataset } from '../src/shared/types'
import { DatasetStore } from '../src/server/cache'
import { loadLocalEnv } from '../src/server/env'

loadLocalEnv(path.resolve(import.meta.dirname, '..'))

const force = process.argv.includes('--force')
const spend = process.argv.includes('--yes') ? 'approved' : 'strict'
const store = new DatasetStore(
  path.resolve(import.meta.dirname, '..', '.cache')
)

let lastPhase = ''
const timer = setInterval(() => {
  const { phase, fraction } = store.progress
  const line = `${phase} ${Math.round(fraction * 100)}%`
  if (line !== lastPhase) {
    process.stdout.write(`\r\x1b[2K${line}`)
    lastPhase = line
  }
}, 100)

await store.ensure({ force, spend })
clearInterval(timer)
process.stdout.write('\r\x1b[2K')

const status = store.status()
if (status.error) {
  console.error(`Build failed: ${status.error}`)
  process.exit(1)
}

const dataset = JSON.parse(
  gunzipSync(await store.get()).toString('utf8')
) as Dataset
const { meta } = dataset
const fmt = (n: number) => n.toLocaleString('en-US')
console.log(
  `@${meta.account.handle} · ${fmt(meta.counts.mine)} tweets · ${fmt(meta.counts.likes)} likes · ${fmt(meta.counts.followers)} followers`
)
console.log(
  `${dataset.clusters.length} topic clusters · ${dataset.inflections.length} inflection points`
)
console.log('timings (ms):', meta.timings)
for (const inf of dataset.inflections.filter((i) => i.metric === 'followers')) {
  const top = inf.causes[0]
  const cause = !top
    ? '—'
    : top.tweet < 0
      ? 'off-platform'
      : dataset.tweets.text[top.tweet]!.replace(/\s+/g, ' ').slice(0, 70)
  console.log(
    `  ${new Date(inf.t * 1000).toISOString().slice(0, 10)}  ${inf.summary}  ←  ${cause}`
  )
}
