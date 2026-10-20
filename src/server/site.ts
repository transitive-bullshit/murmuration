import type { HtmlTagDescriptor } from 'vite'

import type { Dataset } from '../shared/types'

// What the published site says about itself: page metadata, JSON-LD,
// robots.txt, sitemap.xml and llms.txt, all derived from the export so they
// stay accurate as the archive grows.

export const SITE_NAME = 'Murmuration'
export const SHARE_IMAGE = {
  path: '/og.jpg',
  width: 1200,
  height: 630,
  type: 'image/jpeg'
} as const
export const DATASET_PATH = '/data/dataset.json'

export interface SiteOptions {
  /** public origin, e.g. https://murmuration.example.com; links stay relative without it */
  origin?: string
  /** source repository URL */
  repository?: string
  /** size of the published dataset in bytes */
  datasetBytes: number
}

export interface Site {
  origin: string | undefined
  title: string
  shareTitle: string
  description: string
  imageAlt: string
  handle: string
  name: string
  repository: string | undefined
  datasetBytes: number
  ds: Pick<Dataset, 'meta' | 'clusters'>
}

/**
 * The site's public origin: `SITE_URL`, else Vercel's production domain (set
 * when Vercel builds), else package.json `homepage`.
 */
export function resolveOrigin(
  env: Record<string, string | undefined>,
  homepage?: string
): string | undefined {
  const candidates = [
    env.SITE_URL,
    env.VERCEL_PROJECT_PRODUCTION_URL &&
      `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`,
    homepage
  ]
  for (const raw of candidates) {
    if (!raw) continue
    try {
      const url = new URL(raw)
      if (url.protocol === 'https:' || url.protocol === 'http:')
        return url.origin
    } catch {
      // not a URL; try the next source
    }
  }
  return undefined
}

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1
})
const year = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).getUTCFullYear()
const isoDate = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toISOString().slice(0, 10)

export function describeSite(
  ds: Pick<Dataset, 'meta' | 'clusters'>,
  options: SiteOptions
): Site {
  const { handle, name: rawName } = ds.meta.account
  const { counts } = ds.meta
  const name = rawName || `@${handle}`
  return {
    origin: options.origin,
    title: `${name} (@${handle}) on X, in 3D · ${SITE_NAME}`,
    shareTitle: `${name} on X, in 3D`,
    // ~155 characters, so search results show it whole.
    description: `${compact.format(counts.mine)} tweets and ${compact.format(counts.likes)} likes from ${name} (@${handle}), arranged by meaning in 3D: topics, what lands, audience growth and closest relationships.`,
    imageAlt: `A glowing 3D constellation of ${name}'s tweets and likes, clustered by topic, beside the title “murmuration”.`,
    handle,
    name,
    repository: options.repository,
    datasetBytes: options.datasetBytes,
    ds
  }
}

/** Absolute when the origin is known, else root-relative. */
function href(site: Site, pathname: string) {
  return `${site.origin ?? ''}${pathname}`
}

function megabytes(bytes: number) {
  return `${(bytes / 1e6).toFixed(1)} MB`
}

/** <head> tags for search engines, link unfurls and structured data. */
export function headTags(site: Site): HtmlTagDescriptor[] {
  const meta = (attrs: Record<string, string>): HtmlTagDescriptor => ({
    tag: 'meta',
    attrs,
    injectTo: 'head'
  })
  const link = (attrs: Record<string, string>): HtmlTagDescriptor => ({
    tag: 'link',
    attrs,
    injectTo: 'head'
  })
  const image = href(site, SHARE_IMAGE.path)
  const tags: HtmlTagDescriptor[] = [
    meta({ name: 'description', content: site.description }),
    meta({ name: 'author', content: site.name }),
    meta({ name: 'application-name', content: SITE_NAME }),
    meta({ name: 'robots', content: 'index, follow, max-image-preview:large' }),
    link({ rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }),
    meta({ property: 'og:type', content: 'website' }),
    meta({ property: 'og:site_name', content: SITE_NAME }),
    meta({ property: 'og:locale', content: 'en_US' }),
    meta({ property: 'og:title', content: site.shareTitle }),
    meta({ property: 'og:description', content: site.description }),
    meta({ property: 'og:image', content: image }),
    meta({ property: 'og:image:type', content: SHARE_IMAGE.type }),
    meta({ property: 'og:image:width', content: String(SHARE_IMAGE.width) }),
    meta({ property: 'og:image:height', content: String(SHARE_IMAGE.height) }),
    meta({ property: 'og:image:alt', content: site.imageAlt }),
    // X reads title, description and image from the og: tags above.
    meta({ name: 'twitter:card', content: 'summary_large_image' }),
    meta({ name: 'twitter:site', content: `@${site.handle}` }),
    meta({ name: 'twitter:creator', content: `@${site.handle}` }),
    meta({ name: 'twitter:image:alt', content: site.imageAlt }),
    {
      tag: 'script',
      attrs: { type: 'application/ld+json' },
      // `<` can't close the script tag once escaped.
      children: JSON.stringify(jsonLd(site)).replaceAll('<', '\\u003c'),
      injectTo: 'head'
    },
    {
      tag: 'noscript',
      children: noscript(site),
      injectTo: 'body-prepend'
    }
  ]
  if (site.origin) {
    tags.splice(
      4,
      0,
      link({ rel: 'canonical', href: `${site.origin}/` }),
      meta({ property: 'og:url', content: `${site.origin}/` })
    )
  }
  return tags
}

/** Schema.org graph: the site, its author, the app, its source and the data behind it. */
export function jsonLd(site: Site) {
  const { meta } = site.ds
  const base = site.origin ?? ''
  const id = (fragment: string) => `${base}/#${fragment}`
  const profile = `https://x.com/${site.handle}`
  // Individual topic terms ("webgl", "threejs") make better keywords than labels.
  const keywords = [
    ...new Set(topClusters(site, 12).flatMap((c) => c.label.split(' · ')))
  ]
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'WebSite',
      '@id': id('website'),
      url: `${base}/`,
      name: SITE_NAME,
      alternateName: site.shareTitle,
      description: site.description,
      inLanguage: 'en',
      author: { '@id': id('person') },
      publisher: { '@id': id('person') }
    },
    {
      '@type': 'Person',
      '@id': id('person'),
      name: site.name,
      alternateName: `@${site.handle}`,
      url: profile,
      sameAs: [profile]
    },
    {
      '@type': 'WebApplication',
      '@id': id('app'),
      name: SITE_NAME,
      url: `${base}/`,
      description: site.description,
      applicationCategory: 'Data visualization',
      operatingSystem: 'Any',
      browserRequirements: 'Requires JavaScript and WebGL 2',
      isAccessibleForFree: true,
      image: href(site, SHARE_IMAGE.path),
      author: { '@id': id('person') },
      ...(site.repository && { isBasedOn: { '@id': id('source') } })
    },
    {
      '@type': 'Dataset',
      '@id': id('dataset'),
      name: `${site.name}'s X archive (@${site.handle})`,
      description: `${meta.counts.mine.toLocaleString('en-US')} tweets and ${meta.counts.likes.toLocaleString('en-US')} likes from ${site.name} (@${site.handle}) with engagement, AI image captions, topic clusters and 3D coordinates, plus weekly engagement and follower series, follower-growth inflection points, and followers and following with relationship closeness. DM text is never included.`,
      creator: { '@id': id('person') },
      url: `${base}/`,
      keywords,
      temporalCoverage: `${isoDate(meta.range.start)}/${isoDate(meta.range.end)}`,
      dateModified: meta.generatedAt,
      isAccessibleForFree: true,
      distribution: {
        '@type': 'DataDownload',
        encodingFormat: 'application/json',
        contentUrl: href(site, DATASET_PATH),
        contentSize: megabytes(site.datasetBytes)
      }
    }
  ]
  if (site.repository)
    graph.push({
      '@type': 'SoftwareSourceCode',
      '@id': id('source'),
      name: SITE_NAME,
      codeRepository: site.repository,
      programmingLanguage: 'TypeScript',
      license: 'https://opensource.org/licenses/MIT',
      author: { '@id': id('person') }
    })
  return { '@context': 'https://schema.org', '@graph': graph }
}

function topClusters(site: Site, count: number) {
  return [...site.ds.clusters].sort((a, b) => b.size - a.size).slice(0, count)
}

export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!
  )

/** What crawlers and readers without JavaScript see instead of the 3D app. */
function noscript(site: Site) {
  return [
    `<h1>${escapeHtml(site.shareTitle)}</h1>`,
    `<p>${escapeHtml(site.description)}</p>`,
    `<p>This interactive 3D map needs JavaScript and WebGL. The data behind it is at <a href="${DATASET_PATH}">${DATASET_PATH}</a>, described in <a href="/llms.txt">/llms.txt</a>.</p>`
  ].join('')
}

export function robotsTxt(site: Site) {
  const lines = ['User-agent: *', 'Allow: /']
  if (site.origin) lines.push('', `Sitemap: ${site.origin}/sitemap.xml`)
  return `${lines.join('\n')}\n`
}

/** One page; lastmod tracks the latest export. Undefined without an origin (sitemaps need absolute URLs). */
export function sitemapXml(site: Site) {
  if (!site.origin) return undefined
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${site.origin}/</loc>`,
    `    <lastmod>${site.ds.meta.generatedAt.slice(0, 10)}</lastmod>`,
    '  </url>',
    '</urlset>',
    ''
  ].join('\n')
}

/** llms.txt (https://llmstxt.org): what this site is and how to read its data. */
export function llmsTxt(site: Site) {
  const { meta } = site.ds
  const n = (value: number) => value.toLocaleString('en-US')
  const schema = site.repository
    ? `${site.repository}/blob/main/src/shared/types.ts`
    : undefined
  const lines = [
    `# ${SITE_NAME}: ${site.shareTitle}`,
    '',
    `> An interactive 3D map of ${n(meta.counts.mine)} tweets and ${n(meta.counts.likes)} likes from ${site.name} (@${site.handle}) on X, ${year(meta.range.start)}–${year(meta.range.end)}. Tweets are clustered by meaning, scored against what was typical at the time, and tied to audience growth and relationships.`,
    '',
    `The page is a single WebGL app with no server: everything it shows comes from one static JSON file, last exported ${meta.generatedAt.slice(0, 10)}. Direct messages are only counted; DM text is never published.`,
    '',
    '## Data',
    '',
    `- [dataset.json](${href(site, DATASET_PATH)}): the whole dataset (${megabytes(site.datasetBytes)}, JSON). Tables are columnar: parallel arrays indexed by row.`,
    '  - `meta`: account, counts, date range (unix seconds) and how topics were computed.',
    "  - `tweets`: `id`, `kind` (0 = their tweet, 1 = like, 2 = bookmark), `t` (posted, unix seconds; X doesn't record when a like happened), `likes`, `rts`, `replies`, `quotes`, `views` (-1 when unknown), `text`, `media` (first image URL), `caption` (AI image description), `author` (row in `people`, -1 when unknown), `cluster` (row in `clusters`, -1 when unclustered), `lift` and `outlier` (engagement versus their typical tweet at the time).",
    '  - `clusters`: topic labels, top terms and sizes.',
    '  - `series` and `inflections`: weekly engagement and follower estimates, and the follower spikes and surges with their likely causes.',
    '  - `people`: everyone they follow, who follows them, whose tweets they liked, or who they talk with, with interaction counts and a relationship-closeness score. `peopleTimeline` tracks closeness quarter by quarter.',
    ...(schema
      ? [`- [Schema](${schema}): field-by-field TypeScript types.`]
      : []),
    '',
    '## Views',
    '',
    '- Constellation: every tweet and like placed by meaning, with labeled topics.',
    '- Strata: the timeline stacked month by month, colored by topic.',
    '- Growth: the follower curve above every tweet’s engagement, with inflection points traced to likely causes.',
    '- Bangers: the biggest hits and outliers over time.',
    '- Anatomy: which kinds of tweets perform best (format, topic, timing, length) and how that changed.',
    '- Orbit: followers, following and closest relationships over time.',
    '',
    '## Largest topics',
    '',
    ...topClusters(site, 12).map(
      (c) => `- ${c.label} (${n(c.size)} tweets and likes)`
    ),
    '',
    '## Optional',
    '',
    `- [@${site.handle} on X](https://x.com/${site.handle})`,
    ...(site.repository
      ? [`- [Source code](${site.repository}): the open-source app.`]
      : []),
    ''
  ]
  return lines.join('\n')
}
