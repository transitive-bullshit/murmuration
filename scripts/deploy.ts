// Ships the locally built site (dist/) to Vercel production; run it through
// `pnpm deploy:vercel`, which exports and builds first.
//
// Vercel only attaches Web Analytics routes to deployments it builds itself,
// so instead of `vercel deploy --prebuilt` this uploads dist/ as a static
// project whose build step on Vercel (vercel-analytics.mjs) only writes the
// analytics paths into index.html. The data and keys never leave this
// machine, and Vercel skips re-uploading files it already has.
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dist = path.join(root, 'dist')
const link = path.join(root, '.vercel', 'project.json')
const stage = path.join(root, '.vercel', 'stage')

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('No build in dist/: run `pnpm build` first.')
  process.exit(1)
}
if (!existsSync(link)) {
  console.error('Not linked to a Vercel project: run `vercel link` once.')
  process.exit(1)
}

rmSync(stage, { recursive: true, force: true })
cpSync(dist, path.join(stage, 'site'), { recursive: true })
mkdirSync(path.join(stage, '.vercel'))
cpSync(link, path.join(stage, '.vercel', 'project.json'))
cpSync(
  path.join(root, 'scripts', 'vercel-analytics.mjs'),
  path.join(stage, 'vercel-analytics.mjs')
)

// Same headers and Git settings as the repo's vercel.json; only how the
// upload is "built" differs.
const repo = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'))
const config = {
  $schema: repo.$schema,
  framework: null,
  installCommand: 'echo "Nothing to install: the site was built locally."',
  buildCommand: 'node vercel-analytics.mjs',
  outputDirectory: 'site',
  // The project skips builds so Git pushes can't deploy; this upload needs
  // its one-step build to get analytics.
  ignoreCommand: 'exit 1',
  git: repo.git,
  headers: repo.headers
}
writeFileSync(
  path.join(stage, 'vercel.json'),
  `${JSON.stringify(config, null, 2)}\n`
)

const result = spawnSync(
  'vercel',
  ['deploy', '--prod', '--yes', ...process.argv.slice(2)],
  { cwd: stage, stdio: 'inherit' }
)
process.exit(result.status ?? 1)
