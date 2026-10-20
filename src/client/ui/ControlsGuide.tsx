import { useEffect, useRef, useState } from 'react'

const SEEN_KEY = 'murmuration:controls-seen'

const GESTURES: [string, string][] = [
  ['Orbit', 'Drag'],
  ['Pan', 'Two-finger scroll · ⇧ Drag · Right-drag'],
  ['Zoom', 'Pinch · ⌘ Scroll · Mouse wheel'],
  ['Inspect', 'Hover · Click to pin'],
  ['Reset view', 'H']
]

const KEYS: [string, string][] = [
  ['Switch view', '1 – 6'],
  ['Search', '/  or  ⌘K'],
  ['Clear / close', 'Esc'],
  ['Play history (Orbit)', 'Space'],
  ['This guide', '?']
]

/**
 * A small "?" button that opens a cheat sheet of gestures and shortcuts.
 * It opens once automatically on a first visit.
 */
export function ControlsGuide() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let seen = true
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1'
    } catch {}
    if (seen) return
    // Mark as seen only once it has actually been shown.
    const show = setTimeout(() => {
      setOpen(true)
      try {
        localStorage.setItem(SEEN_KEY, '1')
      } catch {}
    }, 2600)
    const hide = setTimeout(() => setOpen(false), 12_000)
    return () => {
      clearTimeout(show)
      clearTimeout(hide)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      if (e.key === '?') setOpen((o) => !o)
      else if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [])

  return (
    <div ref={ref} className='relative'>
      <button
        type='button'
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label='Controls'
        title='Controls (?)'
        className={`glass pressable flex size-9 items-center justify-center rounded-full text-[13px] font-semibold ${
          open ? 'text-ink' : 'text-ink-3 hover:text-ink'
        }`}
      >
        ?
      </button>
      <div
        className={`glass-strong absolute right-0 top-11 z-50 w-[348px] origin-top-right rounded-2xl p-4 transition-[opacity,transform] duration-200 ease-[var(--ease-out)] ${
          open
            ? 'pointer-events-auto scale-100 opacity-100'
            : 'pointer-events-none scale-[0.97] opacity-0'
        }`}
      >
        <Rows title='Navigate' rows={GESTURES} />
        <div className='my-3 h-px bg-white/[0.06]' />
        <Rows title='Keyboard' rows={KEYS} />
        <div className='mt-3 flex items-center gap-2 border-t border-white/[0.06] pt-3'>
          <a
            href='https://github.com/transitive-bullshit/murmuration'
            target='_blank'
            rel='noreferrer'
            className='pressable flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-white/[0.06] text-[11.5px] font-medium text-ink-2 hover:bg-white/[0.1] hover:text-ink'
          >
            <svg
              viewBox='0 0 16 16'
              className='size-3.5'
              fill='currentColor'
              aria-hidden
            >
              <path d='M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z' />
            </svg>
            GitHub
          </a>
          <a
            href='https://x.com/transitive_bs'
            target='_blank'
            rel='noreferrer'
            className='pressable flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-white/[0.06] text-[11.5px] font-medium text-ink-2 hover:bg-white/[0.1] hover:text-ink'
          >
            <svg
              viewBox='0 0 24 24'
              className='size-3'
              fill='currentColor'
              aria-hidden
            >
              <path d='M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' />
            </svg>
            @transitive_bs
          </a>
        </div>
      </div>
    </div>
  )
}

function Rows({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div>
      <div className='eyebrow mb-2'>{title}</div>
      <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5'>
        {rows.map(([label, keys]) => (
          <div key={label} className='contents'>
            <dt className='text-[12px] text-ink-2'>{label}</dt>
            <dd className='text-right text-[11.5px] text-ink tabular'>
              {keys}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
