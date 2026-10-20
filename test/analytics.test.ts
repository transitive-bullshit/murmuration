import { describe, expect, test } from 'vitest'

import { FMT } from '../src/shared/types'
import {
  buildWeeklySeries,
  detectInflections,
  scoreTweets
} from '../src/server/engagement'
import { tweetFeatures } from '../src/server/features'
import { reconstructFollowTimes } from '../src/server/followers'
import type { RawFollowSnapshot, RawTweet } from '../src/server/load'
import { closenessScore } from '../src/server/people'
import {
  DAY,
  LegacyUserIdClock,
  WEEK,
  isSnowflakeUserId,
  snowflakeSeconds,
  weekStart
} from '../src/server/time'

const TWITTER_EPOCH_MS = 1288834974657n
/** A snowflake id minted at `seconds`. */
const snowflakeAt = (seconds: number, salt = 0) =>
  String(((BigInt(seconds * 1000) - TWITTER_EPOCH_MS) << 22n) + BigInt(salt))

const T2020 = Date.UTC(2020, 0, 1) / 1000
const T2024 = Date.UTC(2024, 0, 1) / 1000

describe('time', () => {
  test('decodes snowflake timestamps', () => {
    // A real tweet id from the archive (2023-03-15T14:13:34Z).
    expect(snowflakeSeconds('1636007735119724546')).toBe(
      Date.UTC(2023, 2, 15, 14, 13, 34) / 1000
    )
    expect(snowflakeSeconds('123')).toBeUndefined()
  })

  test('distinguishes snowflake user ids from legacy sequential ids', () => {
    expect(isSnowflakeUserId('327034465')).toBe(false)
    expect(isSnowflakeUserId('1396403679297691654')).toBe(true)
  })

  test('weeks start on Monday', () => {
    const wednesday = Date.UTC(2023, 2, 15, 12) / 1000
    expect(new Date(weekStart(wednesday) * 1000).getUTCDay()).toBe(1)
  })

  test('interpolates legacy user ids monotonically', () => {
    const clock = new LegacyUserIdClock([
      { id: '1000', createdAt: 100 },
      { id: '3000', createdAt: 300 },
      { id: '2000', createdAt: 150 }
    ])
    expect(clock.estimate('2500')).toBeCloseTo(225)
    expect(clock.estimate('500')).toBe(100)
  })
})

describe('follower reconstruction', () => {
  // 3,000 followers who followed at a steady pace over 2020–2023, each with an
  // account created at most ~60 days before they followed (many brand new).
  const followTimes = Array.from(
    { length: 3000 },
    (_, k) => T2020 + (k / 3000) * (T2024 - T2020)
  )
  const members = followTimes.map((t, k) => {
    const lag = (k * 7919) % 5 === 0 ? 0 : ((k * 104729) % 60) * DAY
    return {
      followedAt: t,
      externalUserId: snowflakeAt(Math.floor(t - lag), k % 1000),
      profileId: `p${k}`
    }
  })
  // The archive lists followers newest-first, but in blocks concatenated out of order.
  const newestFirst = [...members].reverse()
  const blocks = [
    newestFirst.slice(0, 700),
    newestFirst.slice(700, 1500),
    newestFirst.slice(1500, 2200),
    newestFirst.slice(2200)
  ]
  const shuffled = [blocks[2]!, blocks[0]!, blocks[3]!, blocks[1]!].flat()
  const snapshot: RawFollowSnapshot = {
    id: 's',
    direction: 'followers',
    status: 'partial',
    completedAt: T2024,
    members: shuffled.map((m, position) => ({
      profileId: m.profileId,
      externalUserId: m.externalUserId,
      position
    }))
  }

  const rec = reconstructFollowTimes(snapshot, new LegacyUserIdClock([]), {
    floor: T2020 - 365 * DAY,
    ceiling: T2024
  })

  test('restores a monotone timeline', () => {
    for (let k = 1; k < rec.times.length; k++)
      expect(rec.times[k]).toBeGreaterThanOrEqual(rec.times[k - 1]!)
  })

  test('recovers follow times to within weeks despite shuffled blocks', () => {
    const errors = members.map(
      (m) => Math.abs(rec.followedAt.get(m.profileId)! - m.followedAt) / DAY
    )
    errors.sort((a, b) => a - b)
    expect(errors[Math.floor(errors.length / 2)]).toBeLessThan(21)
    expect(errors[Math.floor(errors.length * 0.9)]).toBeLessThan(60)
  })

  test('handles a single-member snapshot without NaN', () => {
    const single = reconstructFollowTimes(
      {
        ...snapshot,
        members: [
          {
            profileId: 'solo',
            externalUserId: snowflakeAt(T2020 + 5 * DAY),
            position: 0
          }
        ]
      },
      new LegacyUserIdClock([]),
      { floor: T2020 - 365 * DAY, ceiling: T2024 }
    )
    expect(Number.isFinite(single.followedAt.get('solo'))).toBe(true)
    expect(single.times.length).toBe(1)
  })

  test('never places a follow before the account existed', () => {
    for (const m of members) {
      expect(rec.followedAt.get(m.profileId)!).toBeGreaterThanOrEqual(
        snowflakeSeconds(m.externalUserId)! - 1
      )
    }
  })
})

describe('engagement and inflections', () => {
  const start = weekStart(T2020)
  const weeks = 104
  // Steady baseline: one ~10-like tweet a week and ~10 followers a week.
  const mine = Array.from({ length: weeks }, (_, w) => ({
    t: start + w * WEEK + 2 * DAY,
    likes: 10 + (w % 3),
    rts: 1,
    group: 'original' as const,
    isThreadPart: false
  }))
  // Week 40: a viral tweet. Week 80: followers spike with no viral tweet.
  mine[40] = { ...mine[40]!, likes: 4000, rts: 600 }
  const followerTimes: number[] = []
  for (let w = 0; w < weeks; w++) {
    const gain = w === 40 || w === 41 ? 400 : w === 80 ? 350 : 10
    for (let k = 0; k < gain; k++)
      followerTimes.push(start + w * WEEK + ((k + 0.5) / gain) * WEEK)
  }

  const series = buildWeeklySeries({
    mine,
    likeTimes: [],
    followerTimes: Float64Array.from(followerTimes),
    followingTimes: new Float64Array(),
    snapshotTime: start + weeks * WEEK,
    anchors: [],
    start,
    end: start + (weeks - 1) * WEEK
  })
  const scores = scoreTweets(mine)
  const inflections = detectInflections(series, {
    tweets: mine.map((m, i) => ({
      index: i,
      t: m.t,
      likes: m.likes,
      rts: m.rts,
      lift: scores.lift[i]!,
      outlier: scores.outlier[i]!,
      isReply: false,
      eligible: true
    })),
    followers: []
  })

  test('scores the viral tweet as an outlier far above the norm', () => {
    expect(scores.lift[40]).toBeGreaterThan(100)
    expect(scores.outlier[40]).toBeGreaterThan(5)
    expect(Math.abs(scores.outlier[10]!)).toBeLessThan(2)
  })

  test('attributes the follower spike to the viral tweet', () => {
    const spike = inflections.find(
      (f) =>
        f.metric === 'followers' &&
        f.kind === 'spike' &&
        Math.abs(f.t - (start + 40 * WEEK)) <= WEEK
    )
    expect(spike).toBeDefined()
    expect(spike!.causes[0]!.tweet).toBe(40)
  })

  test('flags an unexplained spike as off-platform', () => {
    const spike = inflections.find(
      (f) =>
        f.metric === 'followers' &&
        f.kind === 'spike' &&
        f.t === start + 80 * WEEK
    )
    expect(spike).toBeDefined()
    expect(spike!.causes[0]!.tweet).toBe(-1)
  })
})

describe('tweet features', () => {
  const base: RawTweet = {
    id: '1',
    kind: 'mine',
    t: T2020,
    text: 'hello world',
    authorProfileId: 'me',
    replyToId: null,
    replyToProfileId: null,
    quotedTweetId: null,
    likes: 0,
    rts: 0,
    replies: -1,
    quotes: -1,
    views: -1,
    mediaType: null,
    mediaUrl: '',
    urls: [],
    mentions: [],
    hashtags: 0
  }
  const ctx = { selfProfileId: 'me', selfThreadParents: new Set(['head']) }

  test('classifies formats with sensible precedence', () => {
    expect(
      tweetFeatures({ ...base, text: 'RT @someone: hi' }, ctx).format
    ).toBe('retweet')
    expect(
      tweetFeatures({ ...base, replyToId: '9', replyToProfileId: 'other' }, ctx)
        .format
    ).toBe('reply')
    expect(tweetFeatures({ ...base, id: 'head' }, ctx).format).toBe('thread')
    expect(
      tweetFeatures({ ...base, urls: ['https://x.com/a/status/123'] }, ctx)
        .format
    ).toBe('quote')
    expect(tweetFeatures({ ...base, mediaType: 'video' }, ctx).format).toBe(
      'video'
    )
    expect(
      tweetFeatures({ ...base, urls: ['https://example.com'] }, ctx).format
    ).toBe('link')
    expect(tweetFeatures(base, ctx).format).toBe('text')
  })

  test('marks self-replies as thread continuations', () => {
    const f = tweetFeatures(
      { ...base, replyToId: 'head', replyToProfileId: 'me' },
      ctx
    )
    expect(f.flags & FMT.threadPart).toBeTruthy()
    expect(f.format).toBe('thread')
  })
})

describe('closeness', () => {
  const score = (c: Partial<Parameters<typeof closenessScore>[0]>) =>
    closenessScore({
      out: 0,
      in: 0,
      dm: 0,
      follower: false,
      following: false,
      ...c
    })

  test('ranks two-way public engagement above DMs and one-sided attention', () => {
    const mutual = score({ out: 20, in: 5, follower: true, following: true })
    const dmHeavy = score({ out: 3, dm: 300, follower: true, following: true })
    const fan = score({ out: 40 })
    // A one-way DM flood contributes nothing (dm counts only the two-way part).
    const spam = score({ dm: 0 })
    expect(mutual).toBeGreaterThan(dmHeavy)
    expect(dmHeavy).toBeGreaterThan(fan)
    expect(fan).toBeGreaterThan(spam)
  })

  test('public mutual engagement needs both directions', () => {
    expect(score({ out: 50, in: 5 })).toBeGreaterThan(2 * score({ out: 50 }))
  })
})
