import { REL, type PeopleColumns, type PeopleTimeline } from '../shared/types'
import type { RawArchive, RawProfile } from './load'
import { median, quantile } from './stats'
import { nextQuarter, quarterStart } from './time'

export interface PersonInteraction {
  profileId: string
  t: number
  kind: 'reply' | 'mention' | 'share' | 'like' | 'inbound'
}

interface Acc {
  profileId: string
  rel: number
  outReplies: number
  outMentions: number
  outLikes: number
  outShares: number
  inMentions: number
  dmIn: number
  dmOut: number
  quarters: Map<
    number,
    { out: number; in: number; dmIn: number; dmOut: number }
  >
}

const WEIGHTS = { reply: 1, mention: 0.5, share: 0.8, like: 0.6 }

// Interactions fade with a ~1 year half-life, so closeness reflects the
// relationship now rather than its lifetime total.
const TAU_YEARS = 1.5
const QUARTER_DECAY = Math.exp(-0.25 / TAU_YEARS)

/**
 * One person's closeness from (recency-decayed) interaction volumes:
 * - public engagement in *both* directions dominates: a geometric mean, so
 *   it is zero unless they also replied to or mentioned you;
 * - your one-sided attention (replies, mentions, likes, reposts) counts less;
 * - DMs count least, and only the two-way part (`dm` = min of in/out);
 * - a mutual follow adds a little.
 */
export function closenessScore(c: {
  out: number
  in: number
  dm: number
  follower: boolean
  following: boolean
}): number {
  const mutualPublic = Math.sqrt(Math.log1p(c.out) * Math.log1p(2 * c.in))
  return (
    1.6 * mutualPublic +
    0.45 * Math.log1p(c.out) +
    0.35 * Math.log1p(c.dm) +
    (c.follower && c.following ? 0.4 : c.follower ? 0.1 : 0)
  )
}

export function buildPeople(args: {
  archive: RawArchive
  interactions: PersonInteraction[]
  followedAt: Map<string, number>
  followingAt: Map<string, number>
  end: number
}): {
  people: PeopleColumns
  timeline: PeopleTimeline
  indexOf: Map<string, number>
} {
  const { archive, interactions, followedAt, followingAt } = args
  const self = archive.account.profileId
  const acc = new Map<string, Acc>()
  const get = (profileId: string): Acc => {
    let a = acc.get(profileId)
    if (!a) {
      a = {
        profileId,
        rel: 0,
        outReplies: 0,
        outMentions: 0,
        outLikes: 0,
        outShares: 0,
        inMentions: 0,
        dmIn: 0,
        dmOut: 0,
        quarters: new Map()
      }
      acc.set(profileId, a)
    }
    return a
  }
  const bucket = (a: Acc, t: number) => {
    const q = quarterStart(t)
    let b = a.quarters.get(q)
    if (!b) {
      b = { out: 0, in: 0, dmIn: 0, dmOut: 0 }
      a.quarters.set(q, b)
    }
    return b
  }

  for (const id of archive.currentFollowers) get(id).rel |= REL.follower
  for (const id of archive.currentFollowing) get(id).rel |= REL.following

  for (const it of interactions) {
    if (it.profileId === self || !it.profileId) continue
    const a = get(it.profileId)
    a.rel |= REL.interacted
    if (it.kind === 'inbound') {
      a.inMentions++
      bucket(a, it.t).in++
      continue
    }
    if (it.kind === 'reply') a.outReplies++
    else if (it.kind === 'mention') a.outMentions++
    else if (it.kind === 'share') a.outShares++
    else {
      a.outLikes++
      a.rel |= REL.author
    }
    bucket(a, it.t).out += WEIGHTS[it.kind]
  }

  for (const dm of archive.dmBuckets) {
    if (dm.profileId === self) continue
    const a = get(dm.profileId)
    a.rel |= REL.dm
    const b = bucket(a, dm.quarter)
    if (dm.direction === 'inbound') {
      a.dmIn += dm.count
      b.dmIn += dm.count
    } else {
      a.dmOut += dm.count
      b.dmOut += dm.count
    }
  }
  acc.delete(self)

  const list = [...acc.values()]

  // Quarterly, recency-decayed closeness for everyone who interacted; the
  // latest quarter is their closeness now.
  const quarters: number[] = []
  for (
    let q = quarterStart(archive.account.createdAt);
    q <= args.end;
    q = nextQuarter(q)
  )
    quarters.push(q)
  const trajectory = (a: Acc): Float64Array => {
    const row = new Float64Array(quarters.length)
    const fAt = followedAt.get(a.profileId) ?? 0
    const gAt = followingAt.get(a.profileId) ?? 0
    let out = 0
    let inn = 0
    let dm = 0
    quarters.forEach((q, k) => {
      const b = a.quarters.get(q)
      out = out * QUARTER_DECAY + (b?.out ?? 0)
      inn = inn * QUARTER_DECAY + (b?.in ?? 0)
      dm = dm * QUARTER_DECAY + Math.min(b?.dmIn ?? 0, b?.dmOut ?? 0)
      const qEnd = quarters[k + 1] ?? args.end
      row[k] = closenessScore({
        out,
        in: inn,
        dm,
        follower: !!(a.rel & REL.follower) && fAt <= qEnd,
        following: !!(a.rel & REL.following) && gAt <= qEnd
      })
    })
    return row
  }
  const followOnly = (a: Acc) =>
    closenessScore({
      out: 0,
      in: 0,
      dm: 0,
      follower: !!(a.rel & REL.follower),
      following: !!(a.rel & REL.following)
    })
  const trajectories = list.map((a) =>
    a.quarters.size > 0 ? trajectory(a) : undefined
  )
  const raw = list.map(
    (a, i) => trajectories[i]?.[quarters.length - 1] ?? followOnly(a)
  )
  const maxRaw = Math.max(1e-6, ...raw)

  // Relationship outliers --------------------------------------------------
  const followerCounts = list
    .map((a) => archive.profiles.get(a.profileId)?.followers ?? -1)
    .filter((f) => f > 0)
    .map((f) => Math.log10(f))
  const fMedian = median(followerCounts)
  const fP995 = quantile(followerCounts, 0.995)

  const people: PeopleColumns = {
    n: list.length,
    id: [],
    handle: [],
    name: [],
    avatar: [],
    followers: [],
    verified: [],
    rel: [],
    followedAt: [],
    followingAt: [],
    outReplies: [],
    outMentions: [],
    outLikes: [],
    outShares: [],
    inMentions: [],
    dmIn: [],
    dmOut: [],
    closeness: [],
    outlier: [],
    outlierReason: []
  }
  const indexOf = new Map<string, number>()
  list.forEach((a, i) => {
    const p: RawProfile | undefined = archive.profiles.get(a.profileId)
    indexOf.set(a.profileId, i)
    people.id.push(a.profileId)
    people.handle.push(p?.handle ?? '')
    people.name.push(p?.name ?? '')
    people.avatar.push(p?.avatar ?? '')
    people.followers.push(p?.followers ?? -1)
    people.verified.push(p?.verified ? 1 : 0)
    people.rel.push(a.rel)
    people.followedAt.push(Math.round(followedAt.get(a.profileId) ?? -1))
    people.followingAt.push(Math.round(followingAt.get(a.profileId) ?? -1))
    people.outReplies.push(a.outReplies)
    people.outMentions.push(a.outMentions)
    people.outLikes.push(a.outLikes)
    people.outShares.push(a.outShares)
    people.inMentions.push(a.inMentions)
    people.dmIn.push(a.dmIn)
    people.dmOut.push(a.dmOut)
    people.closeness.push(round3(Math.pow(raw[i]! / maxRaw, 0.85)))

    const { score, reason } = relationshipOutlier(a, p, { fMedian, fP995 })
    people.outlier.push(round3(score))
    people.outlierReason.push(reason)
  })

  // Store the quarterly timeline for the people who were ever closest, so
  // time travel can show relationships that have since faded.
  const ranked = list
    .map((_, i) => ({
      i,
      peak: trajectories[i] ? Math.max(...trajectories[i]) : 0
    }))
    .filter((x) => x.peak > 0)
    .sort((x, y) => y.peak - x.peak)
    .slice(0, 800)
  const qMax = Math.max(1e-6, ...ranked.map((x) => x.peak))
  const timeline: PeopleTimeline = {
    t: quarters,
    people: ranked.map((x) => x.i),
    closeness: ranked.flatMap((x) =>
      Array.from(trajectories[x.i]!, (v) => round3(Math.pow(v / qMax, 0.85)))
    )
  }

  return { people, timeline, indexOf }
}

function relationshipOutlier(
  a: Acc,
  p: RawProfile | undefined,
  ctx: { fMedian: number; fP995: number }
): { score: number; reason: string } {
  const candidates: { score: number; reason: string }[] = []

  const dmMax = Math.max(a.dmIn, a.dmOut)
  const dmMin = Math.min(a.dmIn, a.dmOut)
  if (dmMax >= 300 && dmMin / dmMax < 0.02) {
    candidates.push({
      score: Math.log10(dmMax),
      reason: `One-sided DMs: ${dmMax.toLocaleString('en-US')} ${a.dmIn > a.dmOut ? 'received' : 'sent'}, ${dmMin} back`
    })
  }

  if (p && p.followers > 0 && a.rel & REL.follower) {
    const lf = Math.log10(p.followers)
    if (lf >= ctx.fP995) {
      candidates.push({
        score: 2 + (lf - ctx.fMedian),
        reason: `Notable follower · ${p.followers.toLocaleString('en-US')} followers`
      })
    }
  }

  if (a.quarters.size >= 3) {
    const totals = [...a.quarters.entries()].map(([q, b]) => ({
      q,
      v: b.out + b.in + Math.min(b.dmIn, b.dmOut) * 2
    }))
    const sum = totals.reduce((s, x) => s + x.v, 0)
    const peak = totals.reduce(
      (best, x) => (x.v > best.v ? x : best),
      totals[0]!
    )
    if (sum >= 25 && peak.v / sum >= 0.6) {
      const d = new Date(peak.q * 1000)
      candidates.push({
        score: 1.5 + (peak.v / sum) * 2,
        reason: `Burst: ${Math.round((peak.v / sum) * 100)}% of your interactions in Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
      })
    }
  }

  if (!candidates.length) return { score: 0, reason: '' }
  return candidates.reduce((best, c) => (c.score > best.score ? c : best))
}

const round3 = (v: number) => Math.round(v * 1000) / 1000
