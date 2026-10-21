import { useMemo, useState, type ReactNode } from 'react'

import type { Inflection } from '../../shared/types'
import { linearToHex } from '../data/color'
import {
  displayText,
  fmtCompact,
  fmtDate,
  fmtInt,
  fmtMonth,
  fmtMultiple,
  fmtRange
} from '../data/format'
import { KIND, type Model } from '../data/model'
import { anatomyStats, type AnatomyBucket } from '../layouts/anatomy'
import { selectBangers } from '../layouts/bangers'
import { median } from '../stats'
import { VIEWS, useApp, type AnatomyGroup } from '../store'
import { relLabel } from './cards'
import { COMPACT, useMedia } from './useMedia'

export function ViewPanel({ model }: { model: Model }) {
  const view = useApp((s) => s.view)
  const meta = VIEWS.find((v) => v.id === view)!
  const wide = useMedia('(min-width: 1100px)')
  const compact = useMedia(COMPACT)
  // On phones the scene gets the screen; insights open on request.
  const [open, setOpen] = useState(!compact)
  const expanded = wide || open
  if (compact && !open)
    return (
      <aside className='pointer-events-none absolute left-4 top-[var(--header-h,72px)] z-20'>
        <button
          key={view}
          type='button'
          onClick={() => setOpen(true)}
          className='glass pressable fade-in pointer-events-auto flex h-9 items-center gap-2 rounded-full pl-4 pr-3 text-[13px]'
        >
          <span className='font-display font-semibold tracking-[-0.01em] text-ink'>
            {meta.label}
          </span>
          <span className='text-ink-3'>Insights</span>
          <svg
            viewBox='0 0 16 16'
            className='size-3 text-ink-3'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.6'
            strokeLinecap='round'
            strokeLinejoin='round'
            aria-hidden
          >
            <path d='m4 6 4 4 4-4' />
          </svg>
        </button>
      </aside>
    )
  return (
    <aside className='pointer-events-none absolute bottom-28 left-4 top-[var(--header-h,72px)] z-20 flex w-[330px] max-w-[calc(100vw-32px)] flex-col'>
      <div
        key={view}
        className='glass fade-in pointer-events-auto flex max-h-full flex-col overflow-hidden rounded-3xl'
      >
        <button
          type='button'
          disabled={wide}
          onClick={() => setOpen(!open)}
          className='px-5 pb-3 pt-4 text-left disabled:cursor-default'
        >
          <div className='flex items-center justify-between font-display text-[22px] font-semibold tracking-[-0.025em] text-ink'>
            {meta.label}
            {!wide && (
              <span className='text-[13px] font-normal text-ink-3'>
                {open ? 'Hide' : 'Insights'}
              </span>
            )}
          </div>
          <div className='mt-0.5 text-[12.5px] leading-snug text-ink-3'>
            {meta.hint}
          </div>
        </button>
        <div
          className={`scroll-quiet min-h-0 overflow-y-auto px-5 pb-5 ${expanded ? '' : 'hidden'}`}
        >
          {view === 'constellation' && <ConstellationPanel model={model} />}
          {view === 'strata' && <StrataPanel model={model} />}
          {view === 'growth' && <GrowthPanel model={model} />}
          {view === 'bangers' && <BangersPanel model={model} />}
          {view === 'anatomy' && <AnatomyPanel model={model} />}
          {view === 'orbit' && <OrbitPanel model={model} />}
        </div>
      </div>
    </aside>
  )
}

function Section({
  title,
  children,
  aside
}: {
  title: string
  children: ReactNode
  aside?: ReactNode
}) {
  return (
    <section className='mt-4 first:mt-1'>
      <div className='mb-2 flex items-baseline justify-between'>
        <span className='eyebrow'>{title}</span>
        {aside && <span className='text-[10.5px] text-ink-4'>{aside}</span>}
      </div>
      {children}
    </section>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className='rounded-2xl border border-white/[0.05] bg-white/[0.025] px-3 py-2.5'>
      <div className='font-display text-[20px] font-semibold leading-none tracking-[-0.02em] text-ink tabular'>
        {value}
      </div>
      <div className='mt-1.5 text-[10.5px] leading-tight text-ink-3'>
        {label}
      </div>
    </div>
  )
}

// Constellation --------------------------------------------------------------

function ConstellationPanel({ model }: { model: Model }) {
  const focus = useApp((s) => s.focusCluster)
  const setFocus = useApp((s) => s.setFocusCluster)
  const rows = useMemo(() => {
    const k = model.ds.clusters.length
    const mine = Array.from({ length: k }, () => [] as number[])
    const likes = Array.from({ length: k }, () => 0)
    for (let i = 0; i < model.n; i++) {
      const c = model.cluster[i]!
      if (c < 0) continue
      if (model.analyzable[i]) mine[c]!.push(i)
      else if (model.kind[i] !== KIND.mine) likes[c]!++
    }
    return model.ds.clusters.map((c) => ({
      id: c.id,
      label: c.label,
      color: linearToHex(model.clusterColor[c.id] ?? [0.5, 0.5, 0.5]),
      mine: mine[c.id]!.length,
      likes: likes[c.id]!,
      medianEng: median(mine[c.id]!.map((i) => model.eng[i]!)),
      // Share of your tweets on this topic that beat 2× your typical tweet.
      hitRate: mine[c.id]!.length
        ? mine[c.id]!.filter((i) => model.lift[i]! >= 2).length /
          mine[c.id]!.length
        : 0
    }))
  }, [model])
  const sorted = [...rows].sort(
    (a, b) => (b.mine >= 5 ? b.hitRate : -1) - (a.mine >= 5 ? a.hitRate : -1)
  )
  const best = sorted.filter((r) => r.mine >= 15)[0]

  return (
    <>
      {best && (
        <p className='text-[12.5px] leading-relaxed text-ink-2'>
          Your tweets about{' '}
          <span className='font-semibold text-ink'>{best.label}</span> land
          best:{' '}
          <span className='font-semibold text-[#ffd59a]'>
            {Math.round(best.hitRate * 100)}%
          </span>{' '}
          of them beat 2× your usual engagement.
        </p>
      )}
      <Section title='Topics' aside='yours · likes · hits'>
        <ul className='-mx-2 flex flex-col'>
          {sorted.map((r) => (
            <li key={r.id}>
              <button
                type='button'
                onClick={() => setFocus(focus === r.id ? undefined : r.id)}
                className={`pressable flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left ${
                  focus === r.id ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
                }`}
              >
                <span
                  className='size-2 shrink-0 rounded-full'
                  style={{
                    background: r.color,
                    boxShadow: `0 0 10px ${r.color}`
                  }}
                />
                <span className='min-w-0 flex-1 truncate text-[12.5px] text-ink'>
                  {r.label}
                </span>
                <span className='w-9 text-right text-[11px] text-ink-3 tabular'>
                  {fmtCompact(r.mine)}
                </span>
                <span className='w-9 text-right text-[11px] text-ink-4 tabular'>
                  {fmtCompact(r.likes)}
                </span>
                <span
                  className={`w-11 text-right text-[11px] tabular ${r.hitRate >= 0.25 ? 'text-[#ffd59a]' : 'text-ink-3'}`}
                >
                  {r.mine >= 5 ? `${Math.round(r.hitRate * 100)}%` : '—'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      <p className='mt-3 text-[11px] leading-relaxed text-ink-4'>
        Position = meaning (TF-IDF → LSA → UMAP). Bright warm points are yours,
        sized by engagement; dimmer points are likes. Hits = share of your
        tweets on a topic that beat 2× your typical engagement at the time.
        Click a topic to spotlight it.
      </p>
    </>
  )
}

// Strata --------------------------------------------------------------------

function StrataPanel({ model }: { model: Model }) {
  const range = useApp((s) => s.range)
  const setRange = useApp((s) => s.setRange)
  // A year is "active" when the time filter is exactly that calendar year,
  // whether it was set here or by brushing the timeline.
  const yearRange = (y: number): [number, number] => [
    Date.UTC(y, 0, 1) / 1000,
    Date.UTC(y + 1, 0, 1) / 1000 - 1
  ]
  const activeYear = range
    ? model.years.find((y) => {
        const [a, b] = yearRange(y)
        return (
          Math.abs(range[0] - a) < 86_400 && Math.abs(range[1] - b) < 86_400
        )
      })
    : undefined
  const toggleYear = (y: number) =>
    setRange(activeYear === y ? undefined : yearRange(y))
  const facts = useMemo(() => {
    const byYear = new Map<
      number,
      { mine: number; likes: number; topics: Map<number, number> }
    >()
    for (let i = 0; i < model.n; i++) {
      const y = new Date(model.t[i]! * 1000).getUTCFullYear()
      if (y < model.years[0]!) continue
      const row = byYear.get(y) ?? { mine: 0, likes: 0, topics: new Map() }
      if (model.kind[i] === KIND.mine) row.mine++
      else row.likes++
      // Topics of what *you* posted that year.
      const c = model.cluster[i]!
      if (c >= 0 && model.analyzable[i])
        row.topics.set(c, (row.topics.get(c) ?? 0) + 1)
      byYear.set(y, row)
    }
    const years = [...byYear.entries()].sort((a, b) => a[0] - b[0])
    const max = Math.max(1, ...years.map(([, r]) => r.mine + r.likes))
    // Overall topic mix, so each year can show what was *distinctive* about
    // it rather than the same big catch-all topic every time.
    const overall = new Map<number, number>()
    let overallTotal = 0
    for (const [, r] of years) {
      for (const [c, n] of r.topics) {
        overall.set(c, (overall.get(c) ?? 0) + n)
        overallTotal += n
      }
    }
    return years.map(([year, r]) => {
      const total = [...r.topics.values()].reduce((a, b) => a + b, 0)
      const lift = ([c, n]: [number, number]) =>
        n / total / ((overall.get(c) ?? 1) / overallTotal)
      const top = [...r.topics.entries()]
        .filter(([, n]) => n >= Math.max(3, total * 0.03))
        .sort((a, b) => lift(b) - lift(a))[0]
      return {
        year,
        mine: r.mine,
        likes: r.likes,
        max,
        topic: top ? model.ds.clusters[top[0]] : undefined,
        topicId: top?.[0]
      }
    })
  }, [model])

  return (
    <>
      <p className='text-[12.5px] leading-relaxed text-ink-2'>
        Each column is a month: your tweets stack in front, your likes behind.
        Columns are sorted by topic, so the color bands are what you were
        thinking about.
      </p>
      <Section title='By year' aside='click a year to focus it'>
        <ul className='flex flex-col gap-1.5'>
          {facts.map((f) => (
            <li key={f.year}>
              <button
                type='button'
                onClick={() => toggleYear(f.year)}
                aria-pressed={activeYear === f.year}
                title={
                  activeYear === f.year
                    ? 'Show all years'
                    : `Focus on ${f.year}`
                }
                className={`pressable -mx-2 flex w-[calc(100%+16px)] items-center gap-2.5 rounded-lg px-2 py-0.5 text-left transition-opacity ${
                  activeYear === f.year
                    ? 'bg-white/[0.08]'
                    : activeYear !== undefined
                      ? 'opacity-45 hover:opacity-80'
                      : 'hover:bg-white/[0.04]'
                }`}
              >
                <span className='w-9 text-[11.5px] text-ink-3 tabular'>
                  {f.year}
                </span>
                <span className='flex h-2 flex-1 overflow-hidden rounded-full bg-white/[0.04]'>
                  <span
                    className='h-full bg-[#d95926]'
                    style={{ width: `${(f.mine / f.max) * 100}%` }}
                  />
                  <span
                    className='h-full bg-[#3987e5]/70'
                    style={{ width: `${(f.likes / f.max) * 100}%` }}
                  />
                </span>
                <span
                  className='w-[120px] truncate text-right text-[11px]'
                  style={{
                    color:
                      f.topicId !== undefined
                        ? linearToHex(
                            model.clusterColor[f.topicId] ?? [0.6, 0.6, 0.6]
                          )
                        : undefined
                  }}
                >
                  {f.topic?.label.split(' · ').slice(0, 2).join(' · ') ?? '—'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}

// Growth --------------------------------------------------------------------

function GrowthPanel({ model }: { model: Model }) {
  const focusId = useApp((s) => s.focusInflection)
  const setFocus = useApp((s) => s.setFocusInflection)
  const { inflections, series, followerModel } = model.ds
  const focused = inflections.find((f) => f.id === focusId)
  const followerEvents = inflections.filter((f) => f.metric === 'followers')
  const engagementEvents = inflections.filter((f) => f.metric === 'engagement')

  const first = series.followers.findIndex((f) => f > 0)
  const latest = series.followers.at(-1) ?? 0

  if (focused)
    return (
      <InflectionDetail
        model={model}
        inflection={focused}
        onBack={() => setFocus(undefined)}
      />
    )

  return (
    <>
      <div className='grid grid-cols-2 gap-2'>
        <Stat value={fmtCompact(latest)} label='followers now' />
        <Stat
          value={fmtCompact(model.ds.meta.counts.mine)}
          label='tweets posted'
        />
      </div>
      <Section title='Follower inflections' aside='click to explain'>
        <InflectionList items={followerEvents} onPick={setFocus} />
      </Section>
      <Section title='Engagement spikes'>
        <InflectionList items={engagementEvents} onPick={setFocus} />
      </Section>
      <p className='mt-4 text-[11px] leading-relaxed text-ink-4'>
        X doesn&apos;t export follow dates. The curve is reconstructed from your
        archive&apos;s follower order ({followerModel.blocks} blocks re-sorted)
        and each follower&apos;s account-creation time
        {first >= 0 ? `, since ${fmtMonth(series.t[first]!)}` : ''}; after that
        it uses Birdclaw&apos;s exact daily counts.
      </p>
    </>
  )
}

function InflectionList({
  items,
  onPick
}: {
  items: Inflection[]
  onPick: (id: string) => void
}) {
  return (
    <ul className='-mx-2 flex flex-col'>
      {items.map((inf) => (
        <li key={inf.id}>
          <button
            type='button'
            onClick={() => onPick(inf.id)}
            className='pressable w-full rounded-xl px-2 py-2 text-left hover:bg-white/[0.045]'
          >
            <div className='flex items-baseline justify-between gap-2'>
              <span className='text-[12.5px] font-medium text-ink'>
                {inf.kind === 'surge' ? '↗ Surge' : 'Spike'} · {fmtMonth(inf.t)}
              </span>
              <span className='text-[11.5px] font-semibold text-[#ffd59a] tabular'>
                +{fmtCompact(inf.gain)}
              </span>
            </div>
            <div className='mt-0.5 text-[11px] text-ink-3 tabular'>
              {inf.ratio.toFixed(1)}× baseline
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

function InflectionDetail({
  model,
  inflection: inf,
  onBack
}: {
  model: Model
  inflection: Inflection
  onBack: () => void
}) {
  const flyTo = useApp((s) => s.flyTo)
  const people = model.ds.people
  return (
    <>
      <button
        type='button'
        onClick={onBack}
        className='pressable -ml-1 mb-2 text-[11.5px] text-ink-3 hover:text-ink'
      >
        ← All inflections
      </button>
      <div className='text-[15px] font-semibold leading-snug text-ink'>
        {inf.summary}
      </div>
      <div className='mt-1 text-[11.5px] text-ink-3 tabular'>
        {fmtRange(inf.t0, inf.t1)}
      </div>

      <Section title='Most likely causes'>
        <ul className='flex flex-col gap-2'>
          {inf.causes.map((c, k) => (
            <li
              key={k}
              className='rounded-2xl border border-white/[0.05] bg-white/[0.025] p-3'
            >
              <div className='mb-1.5 flex items-center gap-2'>
                <span className='h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]'>
                  <span
                    className='block h-full rounded-full bg-[#ffd59a]'
                    style={{ width: `${Math.round(c.weight * 100)}%` }}
                  />
                </span>
                <span className='text-[11px] font-semibold text-[#ffd59a] tabular'>
                  {Math.round(c.weight * 100)}%
                </span>
              </div>
              {c.tweet >= 0 ? (
                <button
                  type='button'
                  onClick={() => flyTo({ type: 'tweet', index: c.tweet })}
                  className='pressable w-full text-left'
                >
                  <div className='line-clamp-4 text-[12.5px] leading-snug text-ink'>
                    {displayText(model.ds.tweets.text[c.tweet]!)}
                  </div>
                  <div className='mt-1.5 text-[10.5px] leading-snug text-ink-3'>
                    {fmtDate(model.t[c.tweet]!)} · {c.reason}
                  </div>
                </button>
              ) : (
                <div className='text-[12px] leading-snug text-ink-2'>
                  <span className='font-semibold text-ink'>
                    Off-platform or unseen boost.{' '}
                  </span>
                  {c.reason}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>

      {inf.notableFollowers.length > 0 && (
        <Section title='Notable accounts who followed then'>
          <ul className='-mx-2 flex flex-col'>
            {inf.notableFollowers.map((p) => (
              <li key={p}>
                <button
                  type='button'
                  onClick={() => flyTo({ type: 'person', index: p })}
                  className='pressable flex w-full items-center justify-between rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.045]'
                >
                  <span className='truncate text-[12.5px] text-ink'>
                    @{people.handle[p] || people.id[p]}
                  </span>
                  <span className='text-[11px] text-ink-3 tabular'>
                    {fmtCompact(people.followers[p]!)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

// Bangers -------------------------------------------------------------------

function BangersPanel({ model }: { model: Model }) {
  const mode = useApp((s) => s.bangerMode)
  const setMode = useApp((s) => s.setBangerMode)
  const range = useApp((s) => s.range)
  const selected = useApp((s) => s.selected)
  const flyTo = useApp((s) => s.flyTo)
  const bangers = useMemo(
    () => selectBangers(model, mode, range),
    [model, mode, range]
  )
  const stats = useMemo(() => {
    const eng: number[] = []
    let thousands = 0
    for (let i = 0; i < model.n; i++) {
      if (!model.analyzable[i]) continue
      if (range && (model.t[i]! < range[0] || model.t[i]! > range[1])) continue
      eng.push(model.eng[i]!)
      if (model.likes[i]! >= 1000) thousands++
    }
    eng.sort((a, b) => b - a)
    const total = eng.reduce((a, b) => a + b, 0) || 1
    const top = Math.max(1, Math.ceil(eng.length * 0.01))
    const share = eng.slice(0, top).reduce((a, b) => a + b, 0) / total
    return { share, thousands, top }
  }, [model, range])

  return (
    <>
      <div className='mb-3 grid grid-cols-2 gap-0.5 rounded-full bg-white/[0.04] p-0.5'>
        {(
          [
            ['engagement', 'Most engaging'],
            ['outlier', 'Biggest outliers']
          ] as const
        ).map(([id, text]) => (
          <button
            key={id}
            type='button'
            onClick={() => setMode(id)}
            className={`pressable rounded-full py-1 text-[11.5px] font-medium ${mode === id ? 'bg-white/[0.12] text-ink' : 'text-ink-3 hover:text-ink-2'}`}
          >
            {text}
          </button>
        ))}
      </div>
      <div className='grid grid-cols-2 gap-2'>
        <Stat
          value={`${Math.round(stats.share * 100)}%`}
          label={`of your engagement came from your top ${fmtInt(stats.top)} tweets (1%)`}
        />
        <Stat value={fmtInt(stats.thousands)} label='tweets with 1K+ likes' />
      </div>
      <p className='mt-3 text-[11.5px] leading-relaxed text-ink-3'>
        {mode === 'engagement'
          ? 'Ranked by likes + 2× reposts. Height is engagement on a log scale.'
          : 'Ranked by how far each tweet beat your typical tweet at the time, so early hits count as much as recent ones.'}
      </p>
      <Section
        title={`Top ${Math.min(50, bangers.ranked.length)}`}
        aside='click to fly there'
      >
        <ol className='-mx-2 flex flex-col'>
          {bangers.ranked.slice(0, 50).map((i, k) => (
            <li key={i}>
              <button
                type='button'
                onClick={() => flyTo({ type: 'tweet', index: i })}
                className={`pressable flex w-full gap-2.5 rounded-xl px-2 py-2 text-left ${
                  selected?.type === 'tweet' && selected.index === i
                    ? 'bg-white/[0.08]'
                    : 'hover:bg-white/[0.045]'
                }`}
              >
                <span className='w-5 shrink-0 pt-px text-right text-[11px] font-semibold text-ink-4 tabular'>
                  {k + 1}
                </span>
                <span className='min-w-0 flex-1'>
                  <span className='line-clamp-2 text-[12px] leading-snug text-ink'>
                    {displayText(model.ds.tweets.text[i]!) || '(media)'}
                  </span>
                  <span className='mt-1 flex flex-wrap gap-x-2 text-[10.5px] text-ink-3 tabular'>
                    <span>{fmtDate(model.t[i]!)}</span>
                    <span className='text-[#ffd59a]'>
                      {mode === 'engagement'
                        ? `${fmtCompact(model.likes[i]!)} likes`
                        : `+${model.outlier[i]!.toFixed(1)}σ`}
                    </span>
                    {mode === 'engagement' && model.rts[i]! > 0 && (
                      <span>{fmtCompact(model.rts[i]!)} reposts</span>
                    )}
                    <span>{fmtMultiple(model.lift[i]!)} typical</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </Section>
    </>
  )
}

// Anatomy -------------------------------------------------------------------

const GROUPS: { id: AnatomyGroup; label: string }[] = [
  { id: 'format', label: 'Format' },
  { id: 'topic', label: 'Topic' },
  { id: 'weekday', label: 'Day' },
  { id: 'hour', label: 'Hour' },
  { id: 'length', label: 'Length' }
]

function AnatomyPanel({ model }: { model: Model }) {
  const group = useApp((s) => s.anatomyGroup)
  const setGroup = useApp((s) => s.setAnatomyGroup)
  const range = useApp((s) => s.range)
  const stats = useMemo(
    () => anatomyStats(model, group, range),
    [model, group, range]
  )
  // Rank by hit rate (share beating 2× your typical engagement at the time):
  // medians collapse to ~1× for big mixed groups, hit rates still separate.
  const ranked = [...stats.buckets]
    .filter((b) => b.n > 0)
    .sort((a, b) => (b.n >= 5 ? b.hitRate : -1) - (a.n >= 5 ? a.hitRate : -1))
  const best = ranked.find((b) => b.n >= 20)
  const maxHit = Math.max(0.01, ...ranked.map((b) => b.hitRate))

  return (
    <>
      <div className='mb-3 grid grid-cols-5 gap-0.5 rounded-full bg-white/[0.04] p-0.5'>
        {GROUPS.map((g) => (
          <button
            key={g.id}
            type='button'
            onClick={() => setGroup(g.id)}
            className={`pressable rounded-full py-1 text-[11.5px] font-medium ${group === g.id ? 'bg-white/[0.12] text-ink' : 'text-ink-3 hover:text-ink-2'}`}
          >
            {g.label}
          </button>
        ))}
      </div>
      {best && (
        <p className='text-[12.5px] leading-relaxed text-ink-2'>
          <span className='font-semibold text-ink'>{best.label}</span> performs
          best:{' '}
          <span className='font-semibold text-[#ffd59a]'>
            {Math.round(best.hitRate * 100)}%
          </span>{' '}
          of them beat 2× your typical engagement (median{' '}
          {fmtMultiple(best.medianLift)}).
          {stats.originalsOnly && ' Original tweets only.'}
        </p>
      )}
      <Section title='Ranked by hit rate' aside='n · median · hits'>
        <ul className='flex flex-col gap-2.5'>
          {ranked.map((b) => (
            <BucketRow
              key={b.key}
              bucket={b}
              maxHit={maxHit}
              years={stats.years}
            />
          ))}
        </ul>
      </Section>
      <p className='mt-4 text-[11px] leading-relaxed text-ink-4'>
        A hit is a tweet that drew at least 2× your rolling median for the same
        kind of tweet (originals vs. replies) within ±60 days, so eras with
        fewer followers aren&apos;t penalized. Bars on the right show the hit
        rate by year; the spine in each column traces median engagement.
      </p>
    </>
  )
}

function BucketRow({
  bucket: b,
  maxHit,
  years
}: {
  bucket: AnatomyBucket
  maxHit: number
  years: number[]
}) {
  const trend = b.byYear.map((y) => (y.n >= 5 ? y.hitRate : 0))
  const tMax = Math.max(0.01, ...trend)
  return (
    <li>
      <div className='flex items-center gap-2'>
        <span className='size-2 rounded-full' style={{ background: b.color }} />
        <span className='flex-1 truncate text-[12.5px] text-ink'>
          {b.label}
        </span>
        <span className='w-10 text-right text-[11px] text-ink-4 tabular'>
          {fmtCompact(b.n)}
        </span>
        <span className='w-10 text-right text-[11px] text-ink-3 tabular'>
          {fmtCompact(b.medianEng)}
        </span>
        <span className='w-12 text-right text-[11.5px] font-semibold text-[#ffd59a] tabular'>
          {b.n >= 5 ? `${Math.round(b.hitRate * 100)}%` : '—'}
        </span>
      </div>
      <div className='mt-1 flex items-end gap-2 pl-4'>
        <span className='h-1 flex-1 overflow-hidden rounded-full bg-white/[0.05]'>
          <span
            className='block h-full rounded-full'
            style={{
              width: `${(b.hitRate / maxHit) * 100}%`,
              background: b.color
            }}
          />
        </span>
        <span
          className='flex h-4 w-[92px] items-end gap-px'
          title={`Hit rate by year, ${years[0]}–${years.at(-1)}`}
        >
          {trend.map((v, k) => (
            <span
              key={k}
              className='flex-1 rounded-[1px] bg-white/25'
              style={{
                height: `${Math.max(6, (v / tMax) * 100)}%`,
                opacity: v ? 1 : 0.25
              }}
            />
          ))}
        </span>
      </div>
    </li>
  )
}

// Orbit ---------------------------------------------------------------------

function OrbitPanel({ model }: { model: Model }) {
  const flyTo = useApp((s) => s.flyTo)
  const p = model.ds.people
  const { closest, outliers, mutuals } = useMemo(() => {
    const idx = [...Array(p.n).keys()]
    return {
      closest: idx
        .filter((i) => p.handle[i])
        .sort((a, b) => p.closeness[b]! - p.closeness[a]!)
        .slice(0, 14),
      outliers: idx
        .filter((i) => p.outlier[i]! > 0 && p.handle[i])
        .sort((a, b) => p.outlier[b]! - p.outlier[a]!)
        .slice(0, 10),
      mutuals: idx.filter((i) => (p.rel[i]! & 3) === 3).length
    }
  }, [p])
  const { rising, drifted } = useMemo(() => relationshipDrift(model), [model])

  const row = (i: number, right: ReactNode) => (
    <li key={i}>
      <button
        type='button'
        onClick={() => flyTo({ type: 'person', index: i })}
        className='pressable flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.045]'
      >
        <span
          className='size-1.5 shrink-0 rounded-full'
          style={{ background: relLabel(p.rel[i]!).color }}
        />
        <span className='min-w-0 flex-1 truncate text-[12.5px] text-ink'>
          @{p.handle[i]}
        </span>
        {right}
      </button>
    </li>
  )

  return (
    <>
      <div className='grid grid-cols-3 gap-2'>
        <Stat
          value={fmtCompact(model.ds.meta.counts.followers)}
          label='followers'
        />
        <Stat
          value={fmtCompact(model.ds.meta.counts.following)}
          label='following'
        />
        <Stat value={fmtCompact(mutuals)} label='mutuals' />
      </div>
      <p className='mt-3 text-[12px] leading-relaxed text-ink-3'>
        Angle is when someone entered your orbit (clockwise from{' '}
        {model.years[0]}); distance is recent, two-way engagement. Replies and
        mentions in both directions count most, your one-sided likes and replies
        less, and two-way DMs least; everything fades with a ~1-year half-life.
        Press play to travel through time.
      </p>
      <Section title='Closest' aside='closeness'>
        <ul className='-mx-2 flex flex-col'>
          {closest.map((i) =>
            row(
              i,
              <span className='flex w-16 items-center gap-1.5'>
                <span className='h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]'>
                  <span
                    className='block h-full rounded-full bg-[#43d1a0]'
                    style={{ width: `${p.closeness[i]! * 100}%` }}
                  />
                </span>
              </span>
            )
          )}
        </ul>
      </Section>
      {rising.length > 0 && (
        <Section title='Rising' aside='closeness vs. a year ago'>
          <ul className='-mx-2 flex flex-col'>
            {rising.map(({ i, delta }) =>
              row(
                i,
                <span className='text-[11px] text-[#43d1a0] tabular'>
                  +{Math.round(delta * 100)}
                </span>
              )
            )}
          </ul>
        </Section>
      )}
      {drifted.length > 0 && (
        <Section title='Drifted apart' aside='peak → now'>
          <ul className='-mx-2 flex flex-col'>
            {drifted.map(({ i, peakT }) =>
              row(
                i,
                <span className='text-[11px] text-ink-3 tabular'>
                  peak {fmtMonth(peakT)}
                </span>
              )
            )}
          </ul>
        </Section>
      )}
      <Section title='Outliers'>
        <ul className='-mx-2 flex flex-col'>
          {outliers.map((i) =>
            row(
              i,
              <span className='max-w-[150px] truncate text-[10.5px] text-[#ffd59a]'>
                {p.outlierReason[i]}
              </span>
            )
          )}
        </ul>
      </Section>
      <div className='mt-3 text-[10.5px] text-ink-4 tabular'>
        {fmtInt(p.n)} people in your graph
      </div>
    </>
  )
}

/** People whose closeness grew most over the last year, and those who faded. */
function relationshipDrift(model: Model) {
  const tl = model.ds.peopleTimeline
  const Q = tl.t.length
  const p = model.ds.people
  const rising: { i: number; delta: number }[] = []
  const drifted: { i: number; peakT: number; drop: number }[] = []
  tl.people.forEach((i, row) => {
    if (!p.handle[i] || Q < 5) return
    const values = tl.closeness.slice(row * Q, (row + 1) * Q)
    const now = values[Q - 1]!
    const yearAgo = values[Q - 5]!
    let peak = 0
    for (let q = 1; q < Q; q++) if (values[q]! > values[peak]!) peak = q
    if (now - yearAgo > 0.08) rising.push({ i, delta: now - yearAgo })
    const drop = values[peak]! - now
    if (values[peak]! > 0.35 && drop > 0.25 && peak < Q - 4) {
      drifted.push({ i, peakT: tl.t[peak]!, drop })
    }
  })
  rising.sort((a, b) => b.delta - a.delta)
  drifted.sort((a, b) => b.drop - a.drop)
  return { rising: rising.slice(0, 6), drifted: drifted.slice(0, 6) }
}
