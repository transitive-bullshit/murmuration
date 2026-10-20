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
  ['Switch view', '1 – 5'],
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
        <p className='mt-3 text-[10.5px] leading-relaxed text-ink-4'>
          Zoom keeps whatever is under the cursor fixed in place, so point at
          what you want to look at, then pinch.
        </p>
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
