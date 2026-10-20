import type { Inflection, InflectionCause, WeeklySeries } from '../shared/types'
import { cumulativeAt } from './followers'
import { mad, mean, median, rollingRobust, rollingSeries } from './stats'
import { DAY, WEEK, weekStart } from './time'

export type ScoreGroup = 'original' | 'reply' | 'skip'

export interface ScoredTweet {
  t: number
  likes: number
  rts: number
  group: ScoreGroup
}

export const engagementOf = (likes: number, rts: number) =>
  Math.max(0, likes) + 2 * Math.max(0, rts)

/**
 * Scores each of your tweets against what was typical *for you at the time*:
 * `lift` is engagement ÷ the rolling median of the same kind of tweet (originals
 * vs. replies) within ±60 days, and `outlier` is a robust z-score in log space.
 */
export function scoreTweets(tweets: ScoredTweet[]): {
  lift: Float32Array
  outlier: Float32Array
} {
  const lift = new Float32Array(tweets.length)
  const outlier = new Float32Array(tweets.length)
  for (const group of ['original', 'reply'] as const) {
    const idx = tweets
      .map((t, i) => (t.group === group ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => tweets[a]!.t - tweets[b]!.t)
    if (!idx.length) continue
    const times = idx.map((i) => tweets[i]!.t)
    const eng = idx.map((i) => engagementOf(tweets[i]!.likes, tweets[i]!.rts))
    const logEng = eng.map((e) => Math.log1p(e))
    const radius = 60 * DAY
    const linear = rollingRobust(times, eng, radius)
    const log = rollingRobust(times, logEng, radius)
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k]!
      lift[i] = eng[k]! / Math.max(1, linear.center[k]!)
      const spread = Math.max(log.spread[k]!, 0.5)
      // Shrink z-scores built on tiny numbers (2 likes in a quiet year isn't news).
      const confidence = 1 - Math.exp(-eng[k]! / 15)
      outlier[i] = ((logEng[k]! - log.center[k]!) / spread) * confidence
    }
  }
  return { lift, outlier }
}

export interface SeriesInput {
  mine: Array<ScoredTweet & { isThreadPart: boolean }>
  likeTimes: number[]
  followerTimes: Float64Array
  followingTimes: Float64Array
  snapshotTime: number
  anchors: { t: number; followers: number; following: number }[]
  start: number
  end: number
}

export function buildWeeklySeries(input: SeriesInput): WeeklySeries {
  const first = weekStart(input.start)
  const last = weekStart(input.end)
  const t: number[] = []
  for (let w = first; w <= last; w += WEEK) t.push(w)
  const n = t.length
  const at = (time: number) =>
    Math.min(n - 1, Math.max(0, Math.floor((time - first) / WEEK)))

  const posts = Array.from({ length: n }, () => 0)
  const replies = Array.from({ length: n }, () => 0)
  const likesGiven = Array.from({ length: n }, () => 0)
  const likesReceived = Array.from({ length: n }, () => 0)
  const rtsReceived = Array.from({ length: n }, () => 0)
  const originalLikes: number[][] = Array.from({ length: n }, () => [])
  const originalEng: number[][] = Array.from({ length: n }, () => [])

  for (const tw of input.mine) {
    if (tw.group === 'skip') continue
    const w = at(tw.t)
    likesReceived[w]! += Math.max(0, tw.likes)
    rtsReceived[w]! += Math.max(0, tw.rts)
    if (tw.group === 'original' && !tw.isThreadPart) {
      posts[w]!++
      originalLikes[w]!.push(Math.max(0, tw.likes))
      originalEng[w]!.push(engagementOf(tw.likes, tw.rts))
    } else if (tw.group === 'reply') replies[w]!++
  }
  for (const lt of input.likeTimes) if (lt >= first) likesGiven[at(lt)]!++

  // 13-week centered windows over the pooled per-tweet values.
  const medianLikes = t.map((_, i) =>
    median(originalLikes.slice(Math.max(0, i - 6), Math.min(n, i + 7)).flat())
  )
  const meanEngagement = t.map((_, i) =>
    mean(originalEng.slice(Math.max(0, i - 6), Math.min(n, i + 7)).flat())
  )

  // Followers: reconstructed history until the snapshot, then Birdclaw's
  // exact observed counts.
  const weekEnds = t.map((w) => w + WEEK)
  const reconstructed = cumulativeAt(input.followerTimes, weekEnds)
  const reconstructedFollowing = cumulativeAt(input.followingTimes, weekEnds)
  const anchors = input.anchors.filter((a) => a.t > input.snapshotTime)
  const anchorAt = (time: number, key: 'followers' | 'following') => {
    let best: (typeof anchors)[number] | undefined
    for (const a of anchors) if (a.t <= time) best = a
    return best?.[key]
  }
  const followers = weekEnds.map((we, i) =>
    we > input.snapshotTime
      ? (anchorAt(we, 'followers') ?? reconstructed[i]!)
      : reconstructed[i]!
  )
  const following = weekEnds.map((we, i) =>
    we > input.snapshotTime
      ? (anchorAt(we, 'following') ?? reconstructedFollowing[i]!)
      : reconstructedFollowing[i]!
  )
  const followerGain = followers.map((f, i) =>
    Math.max(0, f - (followers[i - 1] ?? 0))
  )

  return {
    t,
    posts,
    replies,
    likesGiven,
    likesReceived,
    rtsReceived,
    medianLikes,
    meanEngagement,
    followers,
    followerGain,
    following
  }
}

export interface InflectionContext {
  tweets: Array<{
    index: number
    t: number
    likes: number
    rts: number
    lift: number
    outlier: number
    isReply: boolean
    eligible: boolean
  }>
  followers: Array<{ index: number; followedAt: number; followers: number }>
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const fmtDays = (seconds: number) => {
  const days = Math.max(1, Math.round(seconds / DAY))
  return days === 1 ? '1 day before' : `${days} days before`
}

/**
 * Finds weeks where a metric jumped far above its local baseline, merges
 * neighboring hot weeks into events, and attributes each event to the tweets
 * most likely to have caused it.
 */
export function detectInflections(
  series: WeeklySeries,
  ctx: InflectionContext
): Inflection[] {
  const out: Inflection[] = []
  const followerToEngagement = estimateConversion(series)
  const engagement = series.likesReceived.map(
    (l, i) => l + 2 * series.rtsReceived[i]!
  )
  const candidates: Array<{ metric: 'followers' | 'engagement'; ev: Event }> = [
    ...findEvents(series.followerGain, 'followers').map((ev) => ({
      metric: 'followers' as const,
      ev
    })),
    ...findSurges(series.followerGain).map((ev) => ({
      metric: 'followers' as const,
      ev
    })),
    ...findEvents(engagement, 'engagement').map((ev) => ({
      metric: 'engagement' as const,
      ev
    }))
  ]
  for (const { metric, ev } of candidates) {
    const t0 = series.t[ev.start]!
    const t1 = series.t[ev.end]! + WEEK
    const peak = series.t[ev.peak]!
    const causes = attribute({
      metric,
      kind: ev.kind,
      t0,
      t1,
      peak,
      gain: ev.gain,
      baseline: ev.baseline,
      ctx,
      followerToEngagement
    })
    const notableFollowers =
      metric === 'followers'
        ? ctx.followers
            .filter(
              (f) =>
                f.followedAt >= t0 - 3 * DAY &&
                f.followedAt < t1 + 3 * DAY &&
                f.followers >= 2_000
            )
            .sort((a, b) => b.followers - a.followers)
            .slice(0, 8)
            .map((f) => f.index)
        : []
    const weeks = ev.end - ev.start + 1
    const span = weeks === 1 ? '1 week' : `${weeks} weeks`
    const ratio = ev.gain / Math.max(1, ev.baseline)
    const summary =
      ev.kind === 'surge'
        ? `Growth surge · +${fmt(ev.gain)} followers over ${span} · ${ratio.toFixed(1)}× the prior pace`
        : `+${fmt(ev.gain)} ${metric === 'followers' ? 'followers' : 'engagement'} in ${span} · ${ratio.toFixed(1)}× baseline`
    out.push({
      id: `${metric}-${ev.kind}-${t0}`,
      metric,
      kind: ev.kind,
      t: peak,
      t0,
      t1,
      gain: ev.gain,
      baseline: ev.baseline,
      z: ev.z,
      ratio,
      summary,
      causes,
      notableFollowers
    })
  }
  return out.sort((a, b) => a.t - b.t)
}

interface Event {
  kind: 'spike' | 'surge'
  start: number
  end: number
  peak: number
  gain: number
  baseline: number
  z: number
}

function findEvents(
  values: number[],
  metric: 'followers' | 'engagement'
): Event[] {
  const n = values.length
  const baseline = Array.from({ length: n }, () => 0)
  const scale = Array.from({ length: n }, () => 1)
  for (let i = 0; i < n; i++) {
    const around: number[] = []
    for (let j = Math.max(0, i - 13); j < Math.min(n, i + 14); j++) {
      if (Math.abs(j - i) > 2) around.push(values[j]!)
    }
    const b = median(around)
    baseline[i] = b
    scale[i] = Math.max(
      mad(around, b),
      Math.sqrt(b + 1) * 1.5,
      metric === 'followers' ? 4 : 12
    )
  }
  const z = values.map((v, i) => (v - baseline[i]!) / scale[i]!)
  const minExcess = metric === 'followers' ? 25 : 60
  const hot = values.map((v, i) => z[i]! >= 3 && v - baseline[i]! >= minExcess)

  const events: Event[] = []
  for (let i = 0; i < n; i++) {
    if (!hot[i]) continue
    let start = i
    let end = i
    while (
      start > 0 &&
      z[start - 1]! >= 1.5 &&
      values[start - 1]! > baseline[start - 1]!
    )
      start--
    while (
      end < n - 1 &&
      (hot[end + 1] ||
        (z[end + 1]! >= 1.5 && values[end + 1]! > baseline[end + 1]!))
    )
      end++
    end = Math.min(end, start + 7)
    let peak = start
    let gain = 0
    let base = 0
    for (let j = start; j <= end; j++) {
      gain += values[j]!
      base += baseline[j]!
      if (values[j]! > values[peak]!) peak = j
    }
    events.push({
      kind: 'spike',
      start,
      end,
      peak,
      gain,
      baseline: base,
      z: z[peak]!
    })
    i = end
  }
  // Keep the most significant events so the timeline stays legible.
  return events
    .sort((a, b) => b.gain - b.baseline - (a.gain - a.baseline))
    .slice(0, metric === 'followers' ? 14 : 10)
}

/**
 * Sustained shifts in growth rate: the following 8 weeks gain far more per
 * week than the preceding 26. These are the true inflections of the follower
 * curve (e.g. a new audience discovering you), which a spike detector with a
 * local baseline can't see because the whole region is elevated.
 */
function findSurges(gains: number[]): Event[] {
  const n = gains.length
  const PRE = 26
  const POST = 8
  const score = Array.from({ length: n }, () => 0)
  const stats: Array<{ pre: number; post: number }> = []
  for (let w = 0; w < n; w++) {
    const pre = mean(gains.slice(Math.max(0, w - PRE), w))
    const post = mean(gains.slice(w, Math.min(n, w + POST)))
    stats.push({ pre, post })
    if (w < 8 || w + 4 > n) continue
    const ratio = (post + 1) / (pre + 1)
    const excess = (post - pre) * POST
    if (ratio >= 2.5 && excess >= 150) score[w] = excess * Math.log(ratio)
  }
  const events: Event[] = []
  for (let w = 0; w < n; w++) {
    if (!score[w]) continue
    let isPeak = true
    for (let j = Math.max(0, w - POST); j < Math.min(n, w + POST); j++) {
      if (score[j]! > score[w]!) isPeak = false
    }
    if (!isPeak) continue
    const end = Math.min(n - 1, w + POST - 1)
    const { pre, post } = stats[w]!
    events.push({
      kind: 'surge',
      start: w,
      end,
      peak: w,
      gain: Math.round(post * (end - w + 1)),
      baseline: Math.round(pre * (end - w + 1)),
      z: (post - pre) / Math.max(1, Math.sqrt(pre + 1))
    })
  }
  return events
    .sort((a, b) => b.gain - b.baseline - (a.gain - a.baseline))
    .slice(0, 6)
}

/** Typical followers gained per unit of engagement, from non-event weeks. */
function estimateConversion(series: WeeklySeries): number {
  const ratios: number[] = []
  for (let i = 0; i < series.t.length; i++) {
    const eng = series.likesReceived[i]! + 2 * series.rtsReceived[i]!
    if (eng >= 20) ratios.push(series.followerGain[i]! / eng)
  }
  return ratios.length ? median(ratios) : 0.1
}

function attribute(args: {
  metric: 'followers' | 'engagement'
  kind: 'spike' | 'surge'
  t0: number
  t1: number
  peak: number
  gain: number
  baseline: number
  ctx: InflectionContext
  followerToEngagement: number
}): InflectionCause[] {
  const { t0, t1, peak, ctx } = args
  const lookback = (args.kind === 'surge' ? 21 : 10) * DAY
  const candidates = ctx.tweets
    .filter((tw) => tw.eligible && tw.t >= t0 - lookback && tw.t < t1)
    .map((tw) => {
      const eng = engagementOf(tw.likes, tw.rts)
      // Spikes are explained by tweets just before (or during) the peak week;
      // surges by what kicked them off, so favor tweets near the onset.
      const lead = peak + WEEK / 2 - tw.t
      const timing =
        args.kind === 'surge'
          ? Math.exp(-Math.abs(tw.t - peak) / (21 * DAY))
          : lead < -WEEK / 2
            ? 0.35
            : Math.exp(-Math.max(0, lead - WEEK) / (6 * DAY))
      const surprise = 1 + Math.max(0, tw.outlier) * 0.35
      return { tw, eng, score: Math.pow(eng, 0.9) * timing * surprise }
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  const excess = Math.max(1, args.gain - args.baseline)
  const totalEng = candidates.reduce((sum, c) => sum + c.eng, 0)
  // How much of the jump do your own tweets plausibly explain?
  const explained =
    args.metric === 'engagement'
      ? 1
      : Math.min(1, (totalEng * args.followerToEngagement * 3) / excess)

  const total = candidates.reduce((s, c) => s + c.score, 0) || 1
  const causes: InflectionCause[] = candidates
    .map((c) => {
      const parts = [`${fmt(Math.max(0, c.tw.likes))} likes`]
      if (c.tw.rts > 0) parts.push(`${fmt(c.tw.rts)} reposts`)
      if (c.tw.lift >= 1.5) {
        const lift = c.tw.lift >= 10 ? fmt(c.tw.lift) : c.tw.lift.toFixed(1)
        parts.push(`${lift}× your typical ${c.tw.isReply ? 'reply' : 'tweet'}`)
      }
      if (args.kind === 'surge') {
        parts.push(
          c.tw.t < peak
            ? `posted ${fmtDays(peak - c.tw.t)} the surge began`
            : `posted ${Math.max(1, Math.round((c.tw.t - peak) / DAY))} days into the surge`
        )
      } else {
        parts.push(
          c.tw.t < peak
            ? `posted ${fmtDays(peak - c.tw.t)} the spike`
            : c.tw.t < peak + WEEK
              ? 'posted during the spike week'
              : 'posted after the spike began'
        )
      }
      return {
        tweet: c.tw.index,
        weight: (c.score / total) * explained,
        reason: parts.join(' · ')
      }
    })
    .filter((c) => c.weight >= 0.03)

  if (explained < 0.6) {
    causes.push({
      tweet: -1,
      weight: 1 - explained,
      reason:
        totalEng > 0
          ? `Your tweets that week drew only ${fmt(totalEng)} engagement — too little for +${fmt(args.gain)} followers. Likely an off-platform mention, a large account's boost, or a recommendation surge.`
          : `None of your tweets in this window. Likely an off-platform mention, a large account's boost, or a recommendation surge.`
    })
  }
  return causes.sort((a, b) => b.weight - a.weight)
}

export const _internal = { findEvents, estimateConversion, rollingSeries }
