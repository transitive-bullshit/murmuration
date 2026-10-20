import { useState } from 'react'

/**
 * Unobtrusive note when the last build degraded gracefully (e.g. some images
 * couldn't be described). Dismissible; reappears only if a later build warns.
 */
export function BuildNotice({ warnings }: { warnings: readonly string[] }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || warnings.length === 0) return null
  return (
    <div
      role='status'
      className='glass fade-in pointer-events-auto absolute bottom-24 left-4 z-30 flex max-w-[min(420px,calc(100vw-2rem))] items-start gap-2 rounded-2xl px-3 py-2 text-[11.5px] leading-snug text-ink-2'
    >
      <span className='mt-1 size-1.5 shrink-0 rounded-full bg-[#f0c48a]' />
      <div className='min-w-0'>
        {warnings.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <button
        type='button'
        onClick={() => setDismissed(true)}
        aria-label='Dismiss'
        className='pressable -mr-1 shrink-0 rounded-full px-1.5 text-ink-3 hover:text-ink'
      >
        ×
      </button>
    </div>
  )
}
