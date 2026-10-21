import type { Dataset } from '../../src/shared/types'

// A tiny, fully synthetic Dataset shared by the export and build tests.

export const DM =
  'Hey, between us: the launch slips to March because the Series B is still being negotiated, and the lead investor wants another month of numbers before signing'
export const PUBLIC_TWEET =
  'Excited to announce that our open source agent framework now supports streaming tool calls'

export function fixture(): Dataset {
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
