import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { Model } from '../data/model'
import { VIEWS, useApp } from '../store'
import { Brand, KindToggles, Search } from './TopBar'

/**
 * Phone header controls: search and menu buttons, each opening a full-screen
 * sheet with search, the six views and the kind filters.
 */
export function MobileMenu({ model }: { model: Model }) {
  const [sheet, setSheet] = useState<'menu' | 'search'>()
  const close = () => setSheet(undefined)

  return (
    <div className='pointer-events-auto flex shrink-0 items-center gap-2'>
      <IconButton label='Search' onClick={() => setSheet('search')}>
        <circle cx='7' cy='7' r='4.5' />
        <path d='m10.5 10.5 3 3' />
      </IconButton>
      <IconButton label='Menu' onClick={() => setSheet('menu')}>
        <path d='M2.5 5.5h11M2.5 10.5h11' />
      </IconButton>
      {/* On <body>: the header's stacking layer would keep it under the panels. */}
      {sheet &&
        createPortal(
          <Sheet
            model={model}
            focusSearch={sheet === 'search'}
            close={close}
          />,
          document.body
        )}
    </div>
  )
}

function Sheet({
  model,
  focusSearch,
  close
}: {
  model: Model
  focusSearch: boolean
  close: () => void
}) {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <div
      role='dialog'
      aria-modal='true'
      aria-label='Menu'
      className='fade-in scroll-quiet fixed inset-0 z-50 overflow-y-auto bg-[rgb(6_7_10/0.82)] px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))] backdrop-blur-2xl'
      style={{ animationDuration: '220ms' }}
    >
      <div className='mx-auto flex max-w-lg flex-col'>
        <div className='flex items-start justify-between gap-4'>
          <Brand model={model} className='flex-1' />
          <IconButton label='Close menu' onClick={close}>
            <path d='M4 4l8 8M12 4l-8 8' />
          </IconButton>
        </div>

        <div className='mt-5'>
          <Search model={model} inline autoFocus={focusSearch} onPick={close} />
        </div>

        <nav aria-label='Views' className='mt-6'>
          <div className='eyebrow mb-2 px-1'>Views</div>
          <ul className='flex flex-col gap-1'>
            {VIEWS.map((v) => {
              const current = v.id === view
              return (
                <li key={v.id}>
                  <button
                    type='button'
                    aria-current={current ? 'page' : undefined}
                    onClick={() => {
                      setView(v.id)
                      close()
                    }}
                    className={`pressable w-full rounded-2xl px-4 py-3 text-left ${
                      current ? 'bg-white/[0.09]' : 'active:bg-white/[0.05]'
                    }`}
                  >
                    <div
                      className={`font-display text-[19px] font-semibold tracking-[-0.02em] ${current ? 'text-ink' : 'text-ink-2'}`}
                    >
                      {v.label}
                    </div>
                    <div className='mt-0.5 text-[13px] leading-snug text-ink-3'>
                      {v.hint}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className='mt-6'>
          <div className='eyebrow mb-2 px-1'>Show</div>
          <div className='flex'>
            <KindToggles />
          </div>
        </div>

        <p className='mt-6 px-1 text-[12.5px] leading-relaxed text-ink-3'>
          Drag to orbit, pinch to zoom, and tap a point to see its tweet.
        </p>
      </div>
    </div>
  )
}

function IconButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type='button'
      aria-label={label}
      onClick={onClick}
      className='glass pressable flex size-10 shrink-0 items-center justify-center rounded-full text-ink-2'
    >
      <svg
        viewBox='0 0 16 16'
        className='size-4'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.6'
        strokeLinecap='round'
        aria-hidden
      >
        {children}
      </svg>
    </button>
  )
}
