import { useEffect, useRef } from 'react'

import type { Model } from '../data/model'
import { useApp } from '../store'
import { PersonSummary, TweetSummary } from './cards'

/** Follows the pointer and previews whatever particle is under it. */
export function HoverCard({ model }: { model: Model }) {
  const hovered = useApp((s) => s.hovered)
  const selected = useApp((s) => s.selected)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = ref.current
      if (!el) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      const pad = 18
      let x = e.clientX + pad
      let y = e.clientY + pad
      if (x + w > window.innerWidth - 12) x = e.clientX - w - pad
      if (y + h > window.innerHeight - 12)
        y = Math.max(12, window.innerHeight - h - 12)
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [])

  const same =
    hovered &&
    selected &&
    hovered.type === selected.type &&
    hovered.index === selected.index
  const show = !!hovered && !same

  return (
    <div
      ref={ref}
      className='pointer-events-none fixed left-0 top-0 z-40 w-[340px]'
      style={{ transform: 'translate3d(-999px,-999px,0)' }}
    >
      <div
        className={`glass-strong rounded-2xl p-3.5 transition-[opacity,transform] duration-150 ease-out ${
          show ? 'scale-100 opacity-100' : 'scale-[0.97] opacity-0'
        }`}
        style={{ transformOrigin: 'top left' }}
      >
        {hovered?.type === 'tweet' && (
          <TweetSummary model={model} index={hovered.index} />
        )}
        {hovered?.type === 'person' && (
          <PersonSummary model={model} index={hovered.index} />
        )}
      </div>
    </div>
  )
}
