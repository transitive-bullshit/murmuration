import { describe, expect, it } from 'vitest'

import {
  describeSite,
  headTags,
  jsonLd,
  llmsTxt,
  resolveOrigin,
  robotsTxt,
  sitemapXml
} from '../src/server/site'
import type { Dataset } from '../src/shared/types'

const ds = {
  meta: {
    generatedAt: '2026-10-20T12:00:00.000Z',
    account: { handle: 'jane', name: 'Jane <Doe>' },
    counts: { mine: 11617, likes: 36564 },
    range: {
      start: Date.UTC(2011, 5, 30) / 1000,
      end: Date.UTC(2026, 9, 20) / 1000
    }
  },
  clusters: [
    {
      id: 0,
      label: 'webgl · threejs',
      terms: [],
      size: 10,
      centroid: [0, 0, 0]
    },
    { id: 1, label: 'ai · agents', terms: [], size: 30, centroid: [0, 0, 0] }
  ]
} as unknown as Pick<Dataset, 'meta' | 'clusters'>

const site = describeSite(ds, {
  origin: 'https://example.com',
  repository: 'https://github.com/jane/murmuration',
  datasetBytes: 22_300_000,
  datasetPath: '/data/dataset.0123456789ab.json'
})
const relative = describeSite(ds, { datasetBytes: 1 })

const attr = (key: string) =>
  headTags(site).find((t) => t.attrs?.property === key || t.attrs?.name === key)
    ?.attrs?.content

describe('resolveOrigin', () => {
  it('prefers SITE_URL, then the Vercel production domain, then homepage', () => {
    expect(
      resolveOrigin(
        {
          SITE_URL: 'https://a.dev/x/',
          VERCEL_PROJECT_PRODUCTION_URL: 'b.dev'
        },
        'https://c.dev'
      )
    ).toBe('https://a.dev')
    expect(
      resolveOrigin({ VERCEL_PROJECT_PRODUCTION_URL: 'b.dev' }, 'https://c.dev')
    ).toBe('https://b.dev')
    expect(resolveOrigin({ SITE_URL: 'not a url' }, 'https://c.dev')).toBe(
      'https://c.dev'
    )
    expect(resolveOrigin({})).toBeUndefined()
  })
})

describe('page metadata', () => {
  it('uses absolute share URLs and a large-image card', () => {
    expect(attr('og:image')).toBe('https://example.com/og.jpg')
    expect(attr('og:url')).toBe('https://example.com/')
    expect(attr('twitter:card')).toBe('summary_large_image')
    expect(attr('twitter:creator')).toBe('@jane')
    expect(
      headTags(site).find((t) => t.attrs?.rel === 'canonical')?.attrs?.href
    ).toBe('https://example.com/')
  })

  it('keeps the description short enough for search results', () => {
    expect(site.description.length).toBeLessThanOrEqual(160)
    expect(site.description).toContain('11.6K tweets and 36.6K likes')
  })

  it('omits canonical and og:url without an origin', () => {
    const tags = headTags(relative)
    expect(tags.some((t) => t.attrs?.rel === 'canonical')).toBe(false)
    expect(tags.some((t) => t.attrs?.property === 'og:url')).toBe(false)
  })

  it('escapes markup inside JSON-LD and the noscript fallback', () => {
    const tags = headTags(site)
    const script = tags.find((t) => t.tag === 'script')!.children as string
    expect(script).not.toContain('<')
    expect(JSON.parse(script)['@graph'][1].name).toBe('Jane <Doe>')
    const fallback = tags.find((t) => t.tag === 'noscript')!.children as string
    expect(fallback).toContain('Jane &lt;Doe&gt;')
  })
})

describe('structured data', () => {
  it('links the site, author, app, source and dataset', () => {
    const graph = jsonLd(site)['@graph']
    expect(graph.map((n) => n['@type'])).toEqual([
      'WebSite',
      'Person',
      'WebApplication',
      'Dataset',
      'SoftwareSourceCode'
    ])
    const dataset = graph.find((n) => n['@type'] === 'Dataset')!
    expect(dataset.temporalCoverage).toBe('2011-06-30/2026-10-20')
    expect(dataset.keywords).toEqual(['ai', 'agents', 'webgl', 'threejs'])
    expect(dataset.distribution).toMatchObject({
      contentUrl: 'https://example.com/data/dataset.0123456789ab.json',
      contentSize: '22.3 MB'
    })
  })
})

describe('crawler files', () => {
  it('points robots.txt at the sitemap only when the origin is known', () => {
    expect(robotsTxt(site)).toContain(
      'Sitemap: https://example.com/sitemap.xml'
    )
    expect(robotsTxt(relative)).not.toContain('Sitemap')
  })

  it('lists the home page with the export date', () => {
    expect(sitemapXml(site)).toContain('<loc>https://example.com/</loc>')
    expect(sitemapXml(site)).toContain('<lastmod>2026-10-20</lastmod>')
    expect(sitemapXml(relative)).toBeUndefined()
  })

  it('writes llms.txt in the llmstxt.org shape', () => {
    const text = llmsTxt(site)
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^# Murmuration/)
    expect(lines[2]).toMatch(/^> .*2011–2026/)
    expect(text).toContain(
      '[dataset.json](https://example.com/data/dataset.0123456789ab.json)'
    )
    // Largest topic first.
    expect(text.indexOf('ai · agents')).toBeLessThan(
      text.indexOf('webgl · threejs')
    )
  })
})
