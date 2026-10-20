import { describe, expect, test } from 'vitest'

import type { Dataset } from '../src/shared/types'
import {
  DmFingerprints,
  LEAK_RUN,
  auditExport,
  normalizeForAudit,
  toPublicDataset
} from '../src/server/publicExport'

const DM =
  'Hey, between us: the launch slips to March because the Series B is still being negotiated, and the lead investor wants another month of numbers before signing'
const PUBLIC_TWEET =
  'Excited to announce that our open source agent framework now supports streaming tool calls'

function fixture(): Dataset {
  return {
    meta: {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      dbPath: '/Users/someone/.birdclaw/birdclaw.sqlite',
      dbModifiedAt: '2026-01-01T00:00:00.000Z',
      account: { handle: 'me', name: 'Me', profileId: 'p0', createdAt: 0 },
      counts: {
        mine: 1,
        likes: 0,
        bookmarks: 1,
        followers: 1,
        following: 1,
        dms: 4
      },
      range: { start: 0, end: 1 },
      timings: { load: 12 },
      embedding: {
        provider: 'local',
        model: 'm',
        dims: 3,
        captions: 0,
        missing: 0,
        imputed: 0
      }
    },
    tweets: {
      n: 2,
      id: ['1', '2'],
      kind: [0, 2],
      t: [0, 1],
      likes: [5, -1],
      rts: [1, -1],
      replies: [0, -1],
      quotes: [0, -1],
      views: [0, -1],
      flags: [0, 0],
      format: [0, 0],
      len: [PUBLIC_TWEET.length, 12],
      author: [-1, 0],
      cluster: [0, 0],
      sx: [0, 0],
      sy: [0, 0],
      sz: [0, 0],
      outlier: [0, 0],
      lift: [1, 0],
      text: [PUBLIC_TWEET, 'a bookmark'],
      media: ['', ''],
      caption: ['', '']
    },
    clusters: [
      {
        id: 0,
        label: 'agents',
        terms: ['agents'],
        size: 2,
        centroid: [0, 0, 0]
      }
    ],
    series: {
      t: [0],
      posts: [1],
      replies: [0],
      likesGiven: [0],
      likesReceived: [5],
      rtsReceived: [1],
      medianLikes: [5],
      meanEngagement: [7],
      followers: [1],
      followerGain: [1],
      following: [1]
    },
    inflections: [],
    people: {
      n: 1,
      id: ['p1'],
      handle: ['friend'],
      name: ['Friend'],
      avatar: [''],
      followers: [10],
      verified: [0],
      rel: [7],
      followedAt: [0],
      followingAt: [0],
      outReplies: [0],
      outMentions: [0],
      outLikes: [0],
      outShares: [0],
      inMentions: [0],
      dmIn: [3],
      dmOut: [1],
      closeness: [0.5],
      outlier: [0],
      outlierReason: ['']
    },
    peopleTimeline: { t: [0], people: [0], closeness: [0.5] },
    followerModel: {
      method: 'test',
      total: 1,
      following: 1,
      blocks: 1,
      anchors: [{ t: 0, followers: 1 }]
    }
  }
}

function fingerprints(...dms: string[]) {
  const fp = new DmFingerprints()
  for (const dm of dms) fp.addMessage(dm)
  return fp
}

describe('toPublicDataset', () => {
  test('keeps DM counts and bookmarks, drops the archive location', () => {
    const out = toPublicDataset(fixture())
    expect(out.meta.dbPath).toBe('birdclaw.sqlite')
    expect(out.people.dmIn).toEqual([3])
    expect(out.people.dmOut).toEqual([1])
    expect(out.tweets.kind).toEqual([0, 2])
    expect(out.tweets.text[1]).toBe('a bookmark')
  })

  test('drops build warnings', () => {
    const ds = fixture()
    ds.meta.warnings = ['Describing images stopped early']
    expect(toPublicDataset(ds).meta).not.toHaveProperty('warnings')
  })

  test('refuses fields nobody allowlisted', () => {
    const ds = fixture()
    Object.assign(ds.people, { dmText: ['secret'] })
    expect(() => toPublicDataset(ds)).toThrow(/people\.dmText/)
    const nested = fixture()
    Object.assign(nested.meta.counts, { dmWords: 3 })
    expect(() => toPublicDataset(nested)).toThrow(/meta\.counts\.dmWords/)
  })
})

describe('auditExport', () => {
  test('finds a whole DM anywhere and reports only where', () => {
    const ds = toPublicDataset(fixture())
    ds.tweets.caption[1] = `Screenshot reads: ${DM.toUpperCase()}`
    const audit = auditExport(ds, fingerprints(DM))
    expect(audit.leaks).toEqual([
      `tweets.caption[1], tweet 2 (${normalizeForAudit(DM).length} characters of a DM)`
    ])
    expect(audit.leaks.join(' ')).not.toContain('Series B')
  })

  test('catches partial copies with different whitespace', () => {
    const ds = toPublicDataset(fixture())
    // Any copied stretch of 98+ characters spans two adjacent fingerprints.
    const excerpt = DM.slice(7, 105).replace(/ /g, '\n  ')
    ds.inflections.push({
      id: 'x',
      metric: 'followers',
      kind: 'spike',
      t: 0,
      t0: 0,
      t1: 0,
      gain: 0,
      baseline: 0,
      z: 0,
      ratio: 0,
      summary: excerpt,
      causes: [],
      notableFollowers: []
    })
    const [leak] = auditExport(ds, fingerprints(DM)).leaks
    expect(leak).toMatch(
      /^inflections\[0\]\.summary \(\d+ characters of a DM\)$/
    )
  })

  test('counts short shared phrases without blocking', () => {
    const ds = toPublicDataset(fixture())
    // One fingerprint's worth (an article title, say) is not a leak.
    ds.tweets.caption[0] = `An article: ${DM.slice(20, 20 + LEAK_RUN - 1)}…`
    const audit = auditExport(ds, fingerprints(DM))
    expect(audit.leaks).toEqual([])
    expect(audit.sharedPhrases).toBe(1)
  })

  test('catches short DMs copied whole', () => {
    const short = 'Can you intro me to your friend at the fund?'
    const ds = toPublicDataset(fixture())
    ds.people.outlierReason[0] = `asked: ${short}`
    expect(auditExport(ds, fingerprints(short)).leaks).toEqual([
      `people.outlierReason[0] (${short.length} characters of a DM)`
    ])
  })

  test('allows text that was public anyway', () => {
    const fp = fingerprints(`look at this: ${PUBLIC_TWEET}`)
    fp.addPublic(PUBLIC_TWEET)
    const audit = auditExport(toPublicDataset(fixture()), fp)
    expect(audit.leaks).toEqual([])
    expect(audit.publicOverlap).toBeGreaterThan(0)
  })

  test('skips DMs too short to tell apart from ordinary phrases', () => {
    const audit = auditExport(
      toPublicDataset(fixture()),
      fingerprints('ok!', 'a bookmark', DM)
    )
    expect(audit.messages).toBe(3)
    expect(audit.fingerprinted).toBe(1)
    expect(audit.leaks).toEqual([])
  })

  test('flags forbidden values like secrets and local paths', () => {
    const ds = fixture()
    const audit = auditExport(ds, fingerprints(), [
      { label: 'the archive path', value: ds.meta.dbPath }
    ])
    expect(audit.leaks).toEqual(['meta.dbPath (the archive path)'])
  })
})

describe('auditExport with public passages', () => {
  test('private text next to a public quote is still caught', () => {
    const quote = PUBLIC_TWEET
    const secret = 'and between us the round closes Friday at forty million'
    const dm = `${quote} ${secret}`
    const fp = fingerprints(dm)
    fp.addPublic(quote)
    const ds = toPublicDataset(fixture())
    ds.tweets.caption[0] = dm
    expect(auditExport(ds, fp).leaks).toHaveLength(1)
    // The quote alone is public and fine.
    ds.tweets.caption[0] = quote
    expect(auditExport(ds, fp).leaks).toEqual([])
  })
})
