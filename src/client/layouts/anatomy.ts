import { FORMATS } from '../../shared/types'
import { FORMAT_HEX, SERIES, hexToLinear, type RGB } from '../data/color'
import type { Model } from '../data/model'
import { median } from '../stats'
import type { AnatomyGroup } from '../store'

export interface AnatomyBucket {
  key: string
  label: string
  color: string
  rgb: RGB
  /** tweet indices */
  members: number[]
  n: number
  medianLikes: number
  medianEng: number
  /** median of engagement ÷ your typical tweet at the time */
  medianLift: number
  /** share of members that beat 2× your typical tweet */
  hitRate: number
  byYear: {
    year: number
    n: number
    medianEng: number
    medianLift: number
    hitRate: number
  }[]
}

export interface AnatomyStats {
  group: AnatomyGroup
  buckets: AnatomyBucket[]
  years: number[]
  /** overall median engagement across analyzable tweets */
  baselineEng: number
  /** true when replies were excluded from the comparison */
  originalsOnly: boolean
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const HOURS = [
  { label: 'Night', from: 0 },
  { label: 'Early', from: 4 },
  { label: 'Morning', from: 8 },
  { label: 'Afternoon', from: 12 },
  { label: 'Evening', from: 16 },
  { label: 'Late', from: 20 }
]
const LENGTHS = [
  { label: '< 40', max: 40 },
  { label: '40–80', max: 80 },
  { label: '80–140', max: 140 },
  { label: '140–200', max: 200 },
  { label: '200–280', max: 280 },
  { label: '280+', max: Infinity }
]

const FORMAT_LABELS: Record<string, string> = {
  text: 'Text',
  image: 'Image',
  video: 'Video',
  link: 'Link',
  quote: 'Quote',
  thread: 'Thread',
  reply: 'Reply',
  retweet: 'Repost'
}

/** Groups your analyzable tweets and computes per-group performance. */
export function anatomyStats(
  model: Model,
  group: AnatomyGroup,
  range?: [number, number]
): AnatomyStats {
  const { n, analyzable, t, ds } = model
  const defs: { key: string; label: string; color: string; rgb?: RGB }[] = []
  let assign: (i: number) => number

  if (group === 'format') {
    FORMATS.filter((f) => f !== 'retweet').forEach((f) =>
      defs.push({ key: f, label: FORMAT_LABELS[f]!, color: FORMAT_HEX[f]! })
    )
    const order = new Map(defs.map((d, i) => [d.key, i]))
    assign = (i) => order.get(FORMATS[model.format[i]!]!) ?? -1
  } else if (group === 'topic') {
    // Your seven most-used topics, plus everything else.
    const counts = new Map<number, number>()
    for (let i = 0; i < n; i++)
      if (analyzable[i])
        counts.set(model.cluster[i]!, (counts.get(model.cluster[i]!) ?? 0) + 1)
    const top = [...counts.entries()]
      .filter(([c]) => c >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7)
      .map(([c]) => c)
    top.forEach((c, k) => {
      const cluster = ds.clusters[c]
      defs.push({
        key: `c${c}`,
        label: shortLabel(cluster?.label ?? `Topic ${c}`),
        color: SERIES[k]!
      })
    })
    defs.push({ key: 'other', label: 'Other', color: '#7c7b75' })
    const order = new Map(top.map((c, k) => [c, k]))
    assign = (i) => order.get(model.cluster[i]!) ?? top.length
  } else if (group === 'weekday') {
    WEEKDAYS.forEach((d, k) =>
      defs.push({ key: d, label: d, color: SERIES[k]! })
    )
    assign = (i) => (new Date(t[i]! * 1000).getDay() + 6) % 7
  } else if (group === 'hour') {
    HOURS.forEach((h, k) =>
      defs.push({
        key: h.label,
        label: `${h.label} ${pad(h.from)}–${pad(h.from + 4)}`,
        color: SERIES[k]!
      })
    )
    assign = (i) => Math.floor(new Date(t[i]! * 1000).getHours() / 4)
  } else {
    LENGTHS.forEach((l, k) =>
      defs.push({ key: l.label, label: `${l.label} chars`, color: SERIES[k]! })
    )
    assign = (i) => LENGTHS.findIndex((l) => ds.tweets.len[i]! < l.max)
  }

  // Replies have a very different baseline, so outside the format view they
  // would drown every other comparison; topic/time/length use originals only.
  const replyFormat = FORMATS.indexOf('reply')
  const originalsOnly = group !== 'format'
  const members: number[][] = defs.map(() => [])
  for (let i = 0; i < n; i++) {
    if (!analyzable[i]) continue
    if (originalsOnly && model.format[i] === replyFormat) continue
    if (t[i]! < model.domain[0]) continue
    if (range && (t[i]! < range[0] || t[i]! > range[1])) continue
    const g = assign(i)
    if (g >= 0 && g < defs.length) members[g]!.push(i)
  }

  const years = model.years
  const all = members.flat()
  const baselineEng = median(all.map((i) => model.eng[i]!))
  const buckets: AnatomyBucket[] = defs.map((d, g) => {
    const idx = members[g]!
    const byYear = years.map((year) => {
      const ys = idx.filter((i) => utcYear(t[i]!) === year)
      return {
        year,
        n: ys.length,
        medianEng: median(ys.map((i) => model.eng[i]!)),
        medianLift: median(ys.map((i) => model.lift[i]!)),
        hitRate: ys.length
          ? ys.filter((i) => model.lift[i]! >= 2).length / ys.length
          : 0
      }
    })
    return {
      key: d.key,
      label: d.label,
      color: d.color,
      rgb: d.rgb ?? hexToLinear(d.color),
      members: idx,
      n: idx.length,
      medianLikes: median(idx.map((i) => Math.max(0, model.likes[i]!))),
      medianEng: median(idx.map((i) => model.eng[i]!)),
      medianLift: median(idx.map((i) => model.lift[i]!)),
      hitRate: idx.length
        ? idx.filter((i) => model.lift[i]! >= 2).length / idx.length
        : 0,
      byYear
    }
  })
  return { group, buckets, years, baselineEng, originalsOnly }
}

const pad = (h: number) => String(h % 24).padStart(2, '0')

/** Calendar year in UTC, matching the time domain and the year axis. */
export const utcYear = (t: number) => new Date(t * 1000).getUTCFullYear()

function shortLabel(label: string) {
  const parts = label.split(' · ')
  return parts.slice(0, 2).join(' · ')
}
