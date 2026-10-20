import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { KIND_HEX } from '../data/color'
import { displayText, fmtCompact, fmtDate, fmtInt } from '../data/format'
import { fetchStatus, requestRebuild } from '../data/load'
import { KIND, searchTweets, type Model } from '../data/model'
import { VIEWS, useApp } from '../store'
import { ControlsGuide } from './ControlsGuide'
import { useSearchInput } from './useKeyboard'

export function TopBar({ model }: { model: Model }) {
  const { meta } = model.ds
  return (
    <header className='pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 p-4'>
      <div className='pointer-events-auto flex min-w-0 items-center gap-3 pl-1 pt-1'>
        <Mark />
        <div className='min-w-0'>
          <div className='font-display text-[17px] font-semibold leading-none tracking-[-0.02em] text-ink'>
            murmuration
          </div>
          <div className='mt-1 truncate text-[11.5px] text-ink-3 tabular'>
            @{meta.account.handle} · {fmtCompact(meta.counts.mine)} tweets ·{' '}
            {fmtCompact(meta.counts.likes)} likes ·{' '}
            {fmtCompact(meta.counts.followers)} followers
          </div>
        </div>
      </div>

      <ViewSwitcher />

      <div className='pointer-events-auto flex items-center gap-2'>
        {import.meta.env.DEV && <StaleNotice />}
        <Search model={model} />
        <KindToggles />
        <ControlsGuide />
      </div>
    </header>
  )
}

function Mark() {
  return (
    <svg viewBox='0 0 32 32' className='size-8 shrink-0' aria-hidden>
      <defs>
        <radialGradient id='mm-core' cx='50%' cy='50%' r='50%'>
          <stop offset='0%' stopColor='#ffe9c9' />
          <stop offset='100%' stopColor='#ffe9c9' stopOpacity='0' />
        </radialGradient>
      </defs>
      <circle cx='16' cy='16' r='15' fill='url(#mm-core)' opacity='0.18' />
      {[
        [9, 19, 1.3],
        [12.5, 15.5, 1.1],
        [16, 13.5, 1.6],
        [19.5, 15, 1],
        [22.5, 12, 0.9],
        [14.5, 20, 0.8],
        [20, 19.5, 0.8],
        [25, 16.5, 0.7],
        [7, 14, 0.6],
        [11, 10.5, 0.6]
      ].map(([x, y, r], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={r}
          fill={i % 3 === 0 ? '#f0c48a' : '#a9c8f2'}
        />
      ))}
    </svg>
  )
}

function ViewSwitcher() {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[view]
      if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [view])

  return (
    <nav
      className='glass pointer-events-auto relative flex items-center rounded-full p-1'
      aria-label='Views'
    >
      {pill && (
        <span
          className='absolute top-1 bottom-1 rounded-full bg-white/[0.11] shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] transition-[transform,width] duration-500 ease-[var(--ease-drawer)]'
          style={{
            transform: `translateX(${pill.x - 4}px)`,
            width: pill.w,
            left: 4
          }}
        />
      )}
      {VIEWS.map((v, k) => (
        <button
          key={v.id}
          ref={(el) => {
            refs.current[v.id] = el
          }}
          type='button'
          title={`${v.hint} (${k + 1})`}
          onClick={() => setView(v.id)}
          className={`pressable relative z-10 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium tracking-[-0.005em] ${
            view === v.id ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
          }`}
        >
          {v.label}
        </button>
      ))}
    </nav>
  )
}

function Search({ model }: { model: Model }) {
  const query = useApp((s) => s.query)
  const setQuery = useApp((s) => s.setQuery)
  const view = useApp((s) => s.view)
  const flyTo = useApp((s) => s.flyTo)
  const inputRef = useSearchInput()
  const [draft, setDraft] = useState(query)
  const [seenQuery, setSeenQuery] = useState(query)
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  // Adopt external changes to the query (e.g. Escape clearing it).
  if (query !== seenQuery) {
    setSeenQuery(query)
    setDraft(query)
  }
  useEffect(() => {
    const t = setTimeout(() => setQuery(draft), 140)
    return () => clearTimeout(t)
  }, [draft, setQuery])

  const isPeople = view === 'orbit'
  const results = useSearchResults(model, query, isPeople)
  const open = focused && query.trim().length > 0

  const pick = (k: number) => {
    const r = results.items[k]
    if (!r) return
    flyTo({ type: isPeople ? 'person' : 'tweet', index: r })
    inputRef.current?.blur()
  }

  return (
    <div className='relative'>
      <label className='glass group flex h-9 w-[clamp(180px,22vw,290px)] items-center gap-2 rounded-full px-3 text-[12.5px] transition-[border-color] focus-within:border-white/20'>
        <svg
          viewBox='0 0 16 16'
          className='size-3.5 shrink-0 text-ink-3'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.6'
        >
          <circle cx='7' cy='7' r='4.5' />
          <path d='m10.5 10.5 3 3' strokeLinecap='round' />
        </svg>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setActive(0)
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDraft('')
              setQuery('')
              e.currentTarget.blur()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(results.items.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
              setQuery(draft)
              pick(active)
            }
          }}
          placeholder={isPeople ? 'Find a person…' : 'Search tweets & likes…'}
          className='min-w-0 flex-1 bg-transparent text-ink placeholder:text-ink-4 focus:outline-none'
          spellCheck={false}
        />
        {query ? (
          <span className='shrink-0 text-[11px] text-ink-3 tabular'>
            {fmtInt(results.total)}
          </span>
        ) : (
          <kbd className='shrink-0 rounded border border-white/10 px-1.5 py-px font-sans text-[10px] text-ink-4'>
            /
          </kbd>
        )}
      </label>
      {open && results.items.length > 0 && (
        <div
          className='glass-strong fade-in absolute right-0 top-11 z-50 w-[380px] overflow-hidden rounded-2xl p-1.5'
          style={{ animationDuration: '160ms' }}
        >
          {results.items.map((r, k) => (
            <button
              key={r}
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(k)}
              onClick={() => pick(k)}
              className={`flex w-full flex-col gap-0.5 rounded-xl px-3 py-2 text-left ${k === active ? 'bg-white/[0.08]' : ''}`}
            >
              {isPeople ? (
                <PersonResult model={model} index={r} />
              ) : (
                <TweetResult model={model} index={r} query={query} />
              )}
            </button>
          ))}
          <div className='px-3 pb-1 pt-1.5 text-[10.5px] text-ink-4'>
            {fmtInt(results.total)} matches · ↑↓ to move · ↵ to fly there
          </div>
        </div>
      )}
    </div>
  )
}

function TweetResult({
  model,
  index,
  query
}: {
  model: Model
  index: number
  query: string
}) {
  const mine = model.kind[index] === KIND.mine
  const author = model.ds.tweets.author[index]!
  const text = model.ds.tweets.text[index]!
  const caption = model.ds.tweets.caption?.[index] ?? ''
  const textLower = text.toLowerCase()
  // When only the image description matched, show it so the hit makes sense.
  const viaImage =
    caption !== '' &&
    query
      .toLowerCase()
      .split(/\s+/)
      .some((term) => term && !textLower.includes(term))
  return (
    <>
      <span className='line-clamp-2 text-[12.5px] leading-snug text-ink'>
        {displayText(text)}
      </span>
      {viaImage && (
        <span className='line-clamp-1 text-[11px] leading-snug text-ink-3'>
          Image · {caption.split('\n')[0]}
        </span>
      )}
      <span className='flex items-center gap-1.5 text-[10.5px] text-ink-3 tabular'>
        <span
          className='size-1.5 rounded-full'
          style={{ background: mine ? KIND_HEX.mine : KIND_HEX.like }}
        />
        {mine
          ? 'You'
          : author >= 0 && model.ds.people.handle[author]
            ? `Liked · @${model.ds.people.handle[author]}`
            : 'Liked'}{' '}
        · {fmtDate(model.t[index]!)}
        {model.likes[index]! > 0 &&
          ` · ${fmtCompact(model.likes[index]!)} likes`}
      </span>
    </>
  )
}

function PersonResult({ model, index }: { model: Model; index: number }) {
  const p = model.ds.people
  return (
    <>
      <span className='text-[12.5px] text-ink'>
        {p.name[index] || `@${p.handle[index]}`}{' '}
        <span className='text-ink-3'>@{p.handle[index]}</span>
      </span>
      <span className='text-[10.5px] text-ink-3 tabular'>
        closeness {Math.round(p.closeness[index]! * 100)}
        {p.followers[index]! > 0 &&
          ` · ${fmtCompact(p.followers[index]!)} followers`}
      </span>
    </>
  )
}

function useSearchResults(
  model: Model,
  query: string,
  people: boolean
): { total: number; items: number[] } {
  return useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return { total: 0, items: [] }
    if (people) {
      const p = model.ds.people
      const needle = q.replace(/^@/, '')
      const hits: number[] = []
      for (let i = 0; i < p.n; i++) {
        if (
          p.handle[i]!.toLowerCase().includes(needle) ||
          p.name[i]!.toLowerCase().includes(needle)
        )
          hits.push(i)
      }
      hits.sort(
        (a, b) =>
          p.closeness[b]! - p.closeness[a]! || p.followers[b]! - p.followers[a]!
      )
      return { total: hits.length, items: hits.slice(0, 7) }
    }
    const hits = Array.from(searchTweets(model, q))
    // Your own tweets first (by engagement), then likes (newest first).
    hits.sort((a, b) => {
      const ma = model.kind[a] === KIND.mine ? 1 : 0
      const mb = model.kind[b] === KIND.mine ? 1 : 0
      if (ma !== mb) return mb - ma
      return ma ? model.eng[b]! - model.eng[a]! : model.t[b]! - model.t[a]!
    })
    return { total: hits.length, items: hits.slice(0, 7) }
  }, [model, query, people])
}

const KINDS = [
  { label: 'Yours', color: KIND_HEX.mine },
  { label: 'Likes', color: KIND_HEX.like },
  { label: 'Saved', color: KIND_HEX.bookmark }
] as const

function KindToggles() {
  const kinds = useApp((s) => s.kinds)
  const toggle = useApp((s) => s.toggleKind)
  const media = useApp((s) => s.mediaPreviews)
  const setMedia = useApp((s) => s.setMediaPreviews)
  return (
    <div className='glass flex h-9 items-center gap-0.5 rounded-full p-1'>
      {KINDS.map((k, i) => (
        <button
          key={k.label}
          type='button'
          onClick={() => toggle(i as 0 | 1 | 2)}
          aria-pressed={kinds[i]}
          className={`pressable flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium ${
            kinds[i]
              ? 'text-ink'
              : 'text-ink-4 line-through decoration-white/20'
          } hover:bg-white/[0.06]`}
        >
          <span
            className='size-1.5 rounded-full transition-opacity'
            style={{ background: k.color, opacity: kinds[i] ? 1 : 0.3 }}
          />
          {k.label}
        </button>
      ))}
      <span className='mx-0.5 h-4 w-px bg-white/10' />
      <button
        type='button'
        onClick={() => setMedia(!media)}
        aria-pressed={media}
        title={
          media
            ? 'Media previews on (loads images from X)'
            : 'Media previews off (fully offline)'
        }
        className={`pressable flex size-7 items-center justify-center rounded-full hover:bg-white/[0.06] ${media ? 'text-ink-2' : 'text-ink-4'}`}
      >
        <svg
          viewBox='0 0 16 16'
          className='size-3.5'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.4'
        >
          <rect x='2' y='3' width='12' height='10' rx='2' />
          <circle cx='6' cy='7' r='1.2' />
          <path
            d='m3.5 12 3.5-3.5 2.5 2.5 1.5-1.5 2 2'
            strokeLinejoin='round'
          />
          {!media && <path d='M2 2l12 12' strokeLinecap='round' />}
        </svg>
      </button>
    </div>
  )
}

/** Dev only: offers a rebuild (or re-export) when the archive changes. */
function StaleNotice() {
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | undefined>()
  useEffect(() => {
    const check = () => {
      fetchStatus()
        .then((s) => setStale(s.stale))
        .catch(() => {})
    }
    check()
    const t = setInterval(check, 30_000)
    return () => clearInterval(t)
  }, [])
  if (!stale) return null
  return (
    <button
      type='button'
      disabled={busy}
      title={failed}
      onClick={() => {
        setBusy(true)
        setFailed(undefined)
        void (async () => {
          await requestRebuild()
          for (;;) {
            const s = await fetchStatus()
            if (s.error) {
              setFailed(s.error)
              setBusy(false)
              return
            }
            if (s.ready && !s.stale) break
            await new Promise((r) => setTimeout(r, 500))
          }
          window.location.reload()
        })()
      }}
      className='glass pressable fade-in flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-[11.5px] text-ink-2 hover:text-ink'
    >
      <span className='size-1.5 animate-pulse rounded-full bg-[#f0c48a]' />
      {busy
        ? 'Re-reading…'
        : failed
          ? 'Refresh failed · retry'
          : 'New data · refresh'}
    </button>
  )
}
