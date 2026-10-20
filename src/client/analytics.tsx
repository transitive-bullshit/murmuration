import { Analytics } from '@vercel/analytics/react'

import { useApp } from './store'

// The project's Web Analytics script and endpoints, written into the page by
// the deploy step on Vercel (scripts/vercel-analytics.mjs): Vercel only hands
// them to builds it runs, and the site is built locally.
const configString =
  document
    .querySelector<HTMLMetaElement>('meta[name="murmuration:analytics"]')
    ?.getAttribute('content') ?? undefined

/**
 * Vercel Web Analytics (cookieless page views), with each of the six views
 * counted as its own page (/constellation, /strata, …) so switching tabs
 * shows up in the dashboard.
 */
export function SiteAnalytics() {
  const view = useApp((s) => s.view)
  return (
    <Analytics
      mode='production'
      configString={configString}
      route={`/${view}`}
      path={`/${view}`}
    />
  )
}
