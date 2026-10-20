import { useMemo } from 'react'

import { displayText, fmtDate, profileUrl, tweetUrl } from '../data/format'
import { KIND, type Model } from '../data/model'
import { useApp } from '../store'
import { PersonSummary, TweetSummary } from './cards'

/** Pinned details for the clicked particle, with neighbors in meaning. */
export function DetailPanel({ model }: { model: Model }) {
  const selected = useApp((s) => s.selected)
  const setSelected = useApp((s) => s.setSelected)
  const open = !!selected

  return (
    <aside
      className={`pointer-events-auto absolute bottom-24 right-4 top-[72px] z-30 flex w-[360px] flex-col transition-[opacity,transform] duration-300 ease-[var(--ease-drawer)] ${
        open
          ? 'translate-x-0 opacity-100'
          : 'pointer-events-none translate-x-6 opacity-0'
      }`}
    >
      <div className='glass-strong flex max-h-full flex-col overflow-hidden rounded-3xl'>
        <div className='flex items-center justify-between px-4 pt-3.5'>
          <span className='eyebrow'>
            {selected?.type === 'person' ? 'Person' : 'Tweet'}
          </span>
          <button
            type='button'
            onClick={() => setSelected(undefined)}
            className='pressable -mr-1.5 flex size-7 items-center justify-center rounded-full text-ink-3 hover:bg-white/[0.07] hover:text-ink'
            aria-label='Close'
          >
            <svg
              viewBox='0 0 16 16'
              className='size-3.5'
              stroke='currentColor'
              strokeWidth='1.6'
              strokeLinecap='round'
            >
              <path d='M4 4l8 8M12 4l-8 8' />
            </svg>
          </button>
        </div>
        <div className='scroll-quiet overflow-y-auto px-4 pb-4 pt-3'>
          {selected?.type === 'tweet' && (
            <TweetDetail model={model} index={selected.index} />
          )}
          {selected?.type === 'person' && (
            <PersonDetail model={model} index={selected.index} />
          )}
        </div>
      </div>
    </aside>
  )
}

function TweetDetail({ model, index }: { model: Model; index: number }) {
  const flyTo = useApp((s) => s.flyTo)
  const neighbors = useMemo(
    () => nearestInMeaning(model, index, 6),
    [model, index]
  )
  return (
    <div className='flex flex-col gap-4'>
      <TweetSummary model={model} index={index} full />
      <a
        href={tweetUrl(model.ds.tweets.id[index]!)}
        target='_blank'
        rel='noreferrer'
        className='pressable flex h-9 items-center justify-center gap-1.5 rounded-full bg-white/[0.08] text-[12.5px] font-medium text-ink hover:bg-white/[0.12]'
      >
        Open on X
        <svg
          viewBox='0 0 16 16'
          className='size-3'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.6'
        >
          <path
            d='M6 3h7v7M13 3 4 12'
            strokeLinecap='round'
            strokeLinejoin='round'
          />
        </svg>
      </a>
      <div>
        <div className='eyebrow mb-2'>Nearby in meaning</div>
        <ul className='flex flex-col gap-1'>
          {neighbors.map((j) => (
            <li key={j}>
              <button
                type='button'
                onClick={() => flyTo({ type: 'tweet', index: j })}
                className='pressable w-full rounded-xl px-2.5 py-2 text-left hover:bg-white/[0.05]'
              >
                <div className='line-clamp-2 text-[12px] leading-snug text-ink-2'>
                  {displayText(model.ds.tweets.text[j]!)}
                </div>
                <div className='mt-0.5 text-[10.5px] text-ink-4 tabular'>
                  {model.kind[j] === KIND.mine ? 'You' : 'Liked'} ·{' '}
                  {fmtDate(model.t[j]!)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function PersonDetail({ model, index }: { model: Model; index: number }) {
  const flyTo = useApp((s) => s.flyTo)
  const handle = model.ds.people.handle[index]
  const liked = useMemo(() => {
    const out: number[] = []
    for (let i = 0; i < model.n; i++)
      if (model.ds.tweets.author[i] === index && model.kind[i] !== KIND.mine)
        out.push(i)
    return out.sort((a, b) => model.t[b]! - model.t[a]!).slice(0, 6)
  }, [model, index])
  const timeline = useMemo(() => {
    const row = model.people.timelineRow[index]!
    if (row < 0) return undefined
    const tl = model.ds.peopleTimeline
    return tl.closeness.slice(row * tl.t.length, (row + 1) * tl.t.length)
  }, [model, index])

  return (
    <div className='flex flex-col gap-4'>
      <PersonSummary model={model} index={index} full />
      {timeline && (
        <div>
          <div className='eyebrow mb-2'>Closeness over time</div>
          <Sparkline values={timeline} />
          <div className='mt-1 flex justify-between text-[10px] text-ink-4 tabular'>
            <span>
              {new Date(model.ds.peopleTimeline.t[0]! * 1000).getFullYear()}
            </span>
            <span>now</span>
          </div>
        </div>
      )}
      {handle && (
        <a
          href={profileUrl(handle)}
          target='_blank'
          rel='noreferrer'
          className='pressable flex h-9 items-center justify-center rounded-full bg-white/[0.08] text-[12.5px] font-medium text-ink hover:bg-white/[0.12]'
        >
          View @{handle} on X
        </a>
      )}
      {liked.length > 0 && (
        <div>
          <div className='eyebrow mb-2'>Their tweets you liked</div>
          <ul className='flex flex-col gap-1'>
            {liked.map((j) => (
              <li key={j}>
                <button
                  type='button'
                  onClick={() => {
                    useApp.getState().setView('constellation')
                    flyTo({ type: 'tweet', index: j })
                  }}
                  className='pressable w-full rounded-xl px-2.5 py-2 text-left hover:bg-white/[0.05]'
                >
                  <div className='line-clamp-2 text-[12px] leading-snug text-ink-2'>
                    {displayText(model.ds.tweets.text[j]!)}
                  </div>
                  <div className='mt-0.5 text-[10.5px] text-ink-4 tabular'>
                    {fmtDate(model.t[j]!)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function Sparkline({
  values,
  height = 44,
  color = '#43d1a0'
}: {
  values: number[]
  height?: number
  color?: string
}) {
  const w = 320
  const max = Math.max(1e-6, ...values)
  const pts = values.map(
    (v, i) =>
      [
        (i / Math.max(1, values.length - 1)) * w,
        height - (v / max) * (height - 4) - 2
      ] as const
  )
  const d = pts
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join('')
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      className='w-full'
      style={{ height }}
      preserveAspectRatio='none'
    >
      <defs>
        <linearGradient id='spark' x1='0' x2='0' y1='0' y2='1'>
          <stop offset='0%' stopColor={color} stopOpacity='0.35' />
          <stop offset='100%' stopColor={color} stopOpacity='0' />
        </linearGradient>
      </defs>
      <path d={`${d}L${w},${height}L0,${height}Z`} fill='url(#spark)' />
      <path
        d={d}
        fill='none'
        stroke={color}
        strokeWidth='1.5'
        vectorEffect='non-scaling-stroke'
      />
    </svg>
  )
}

function nearestInMeaning(model: Model, index: number, k: number): number[] {
  const { sem, n } = model
  const x = sem[index * 3]!
  const y = sem[index * 3 + 1]!
  const z = sem[index * 3 + 2]!
  const best: { i: number; d: number }[] = []
  for (let i = 0; i < n; i++) {
    if (i === index) continue
    const dx = sem[i * 3]! - x
    const dy = sem[i * 3 + 1]! - y
    const dz = sem[i * 3 + 2]! - z
    const d = dx * dx + dy * dy + dz * dz
    if (best.length < k || d < best[best.length - 1]!.d) {
      best.push({ i, d })
      best.sort((a, b) => a.d - b.d)
      if (best.length > k) best.pop()
    }
  }
  return best.map((b) => b.i)
}
