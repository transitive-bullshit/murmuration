// Build step for the deployment that scripts/deploy.ts uploads. Vercel only
// attaches Web Analytics routes to deployments it builds, and hands their
// paths to the build (VERCEL_OBSERVABILITY_CLIENT_CONFIG), so this step writes
// them into the page for src/client/analytics.tsx. Runs on Vercel, plain Node.
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2] ?? 'site/index.html'
const config = process.env.VERCEL_OBSERVABILITY_CLIENT_CONFIG
const tag = /<meta name="murmuration:analytics" content="[^"]*">/
const html = readFileSync(file, 'utf8')
if (!tag.test(html))
  throw new Error(`${file} has no murmuration:analytics <meta> to fill in`)
const attr = (config ?? '{}').replace(
  /[&<>"']/g,
  (c) => `&#${c.charCodeAt(0)};`
)
writeFileSync(
  file,
  html.replace(
    tag,
    () => `<meta name="murmuration:analytics" content="${attr}">`
  )
)
console.log(
  config
    ? 'Wrote the Web Analytics paths into the page'
    : 'No Web Analytics config from Vercel; the page uses the default paths'
)
