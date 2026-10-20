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

const WEIGHTS = { reply: 1, mention: 0.6, share: 0.8, like: 0.3 }

/** One person's mutual-engagement score from interaction counts. */
export function closenessScore(c: {
  out: number
  in: number
  dmIn: number
  dmOut: number
  mutualFollow: boolean
}): number {
  // Conversations count only to the extent they're two-sided, so one-way DM
  // floods (spam, newsletters) don't read as closeness.
  const dmMutual =
    Math.min(c.dmIn, c.dmOut) * 2 +
    Math.min(c.dmIn, c.dmOut, Math.max(c.dmIn, c.dmOut) * 0.1)
  return (
    Math.log1p(c.out) +
    1.2 * Math.log1p(c.in) +
    1.4 * Math.log1p(dmMutual) +
    (c.mutualFollow ? 0.6 : 0) +
    // Reward reciprocity across channels.
    (c.out > 0 && (c.in > 0 || dmMutual > 0) ? 0.5 : 0)
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
  const raw = list.map((a) =>
    closenessScore({
      out:
        a.outReplies * WEIGHTS.reply +
        a.outMentions * WEIGHTS.mention +
        a.outShares * WEIGHTS.share +
        a.outLikes * WEIGHTS.like,
      in: a.inMentions,
      dmIn: a.dmIn,
      dmOut: a.dmOut,
      mutualFollow:
        (a.rel & (REL.follower | REL.following)) ===
        (REL.follower | REL.following)
    })
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

  // Quarterly closeness for the people who matter most --------------------
  const quarters: number[] = []
  for (
    let q = quarterStart(archive.account.createdAt);
    q <= args.end;
    q = nextQuarter(q)
  )
    quarters.push(q)
  const ranked = list
    .map((a, i) => ({ a, i, c: people.closeness[i]! }))
    .filter((x) => x.a.quarters.size > 0)
    .sort((x, y) => y.c - x.c)
    .slice(0, 800)

  const qRaw = ranked.map(({ a }) => {
    // Interactions decay over ~a year so the orbit shows momentum, not totals.
    const row = Array.from({ length: quarters.length }, () => 0)
    let out = 0
    let inn = 0
    let dmIn = 0
    let dmOut = 0
    quarters.forEach((q, k) => {
      const b = a.quarters.get(q)
      out = out * 0.7 + (b?.out ?? 0)
      inn = inn * 0.7 + (b?.in ?? 0)
      dmIn = dmIn * 0.7 + (b?.dmIn ?? 0)
      dmOut = dmOut * 0.7 + (b?.dmOut ?? 0)
      const qEnd = quarters[k + 1] ?? args.end
      const fAt = followedAt.get(a.profileId) ?? Infinity
      const gAt = followingAt.get(a.profileId) ?? Infinity
      row[k] = closenessScore({
        out,
        in: inn,
        dmIn,
        dmOut,
        mutualFollow: fAt < qEnd && gAt < qEnd
      })
    })
    return row
  })
  const qMax = Math.max(1e-6, ...qRaw.flat())
  const timeline: PeopleTimeline = {
    t: quarters,
    people: ranked.map((x) => x.i),
    closeness: qRaw.flat().map((v) => round3(Math.pow(v / qMax, 0.85)))
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
