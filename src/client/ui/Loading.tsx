import { useEffect, useRef, useState } from 'react'

import type { Status } from '../data/load'

/**
 * First-run experience: while the archive is analyzed, a 2D flock wheels
 * across the screen and the phase reads out underneath.
 */
export function Loading({
  status,
  error,
  done
}: {
  status: Status | undefined
  error: string | undefined
  done: boolean
}) {
  const [gone, setGone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setGone(true), 1400)
    return () => clearTimeout(t)
  }, [done])
  if (gone) return null

  const fraction = status?.ready ? 1 : (status?.fraction ?? 0)
  const phase = error
    ? 'Something went wrong'
    : status?.ready
      ? 'Rendering'
      : (status?.phase ?? 'Connecting')

  return (
    <div
      className={`absolute inset-0 z-50 flex items-center justify-center bg-void transition-[opacity,filter] duration-[1200ms] ease-[var(--ease-out)] ${
        done ? 'pointer-events-none opacity-0 blur-sm' : 'opacity-100'
      }`}
    >
      <Flock />
      <div className='relative flex w-[min(440px,86vw)] flex-col items-center text-center'>
        <div className='font-display text-[44px] font-semibold leading-none tracking-[-0.035em] text-ink'>
          murmuration
        </div>
        <div className='mt-3 text-[13.5px] text-ink-3'>
          a quiet observatory for everything you&apos;ve posted and loved
        </div>
        <div className='mt-12 h-px w-full overflow-hidden rounded-full bg-white/8'>
          <div
            className='h-full rounded-full bg-gradient-to-r from-[#3987e5] via-[#f0c48a] to-[#ffe6c4] transition-[width] duration-300 ease-out'
            style={{ width: `${Math.max(4, fraction * 100)}%` }}
          />
        </div>
        <div className='mt-4 flex h-5 items-center gap-2 text-[12.5px] text-ink-2'>
          {!error && (
            <span className='size-1.5 animate-pulse rounded-full bg-[#f0c48a]' />
          )}
          <span key={phase} className='fade-in'>
            {phase}
          </span>
        </div>
        {error && (
          <div className='mt-4 max-w-sm text-[12.5px] leading-relaxed text-[#e66767]'>
            {error}
            <div className='mt-2 text-ink-3'>
              Murmuration reads{' '}
              <code className='text-ink-2'>~/.birdclaw/birdclaw.sqlite</code>{' '}
              (or <code className='text-ink-2'>BIRDCLAW_DB</code>). Run{' '}
              <code className='text-ink-2'>birdclaw import archive</code> first.
            </div>
          </div>
        )}
        {!error && !status?.ready && (
          <div className='mt-2 text-[11.5px] text-ink-4'>
            First run reads your whole archive; after that it&apos;s cached.
          </div>
        )}
      </div>
    </div>
  )
}

function Flock() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const N = 2400
    const dpr = Math.min(2, window.devicePixelRatio)
    let w = 0
    let h = 0
    const resize = () => {
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    // Each bird chases a point on a slowly morphing Lissajous path, delayed by
    // its own phase, so the flock stretches into a ribbon that folds and
    // wheels like a starling murmuration.
    const birds = Array.from({ length: N }, (_, i) => {
      const phase = (i / N) ** 1.4
      return {
        x: w / 2 + (Math.random() - 0.5) * w,
        y: h / 2 + (Math.random() - 0.5) * h,
        vx: 0,
        vy: 0,
        phase,
        spread: 0.4 + Math.random() * 0.9,
        seed: Math.random() * 1000,
        warm: i % 7 === 0
      }
    })
    const path = (t: number) => {
      const a = 1 + 0.35 * Math.sin(t * 0.11)
      return {
        x: w * (0.5 + 0.36 * Math.sin(t * 0.53 * a + 0.4) * Math.cos(t * 0.17)),
        y: h * (0.5 + 0.28 * Math.sin(t * 0.71 + Math.sin(t * 0.23) * 1.6))
      }
    }

    let raf = 0
    let t = 0
    const frame = () => {
      t += 1 / 60
      ctx.fillStyle = 'rgba(3,4,6,0.28)'
      ctx.fillRect(0, 0, w, h)
      for (const b of birds) {
        const p = path(t - b.phase * 3.2)
        const n = Math.sin(b.seed + t * 1.3) * 26 * b.spread
        const m = Math.cos(b.seed * 1.7 + t * 1.1) * 26 * b.spread
        const ax = (p.x + n - b.x) * 0.012
        const ay = (p.y + m - b.y) * 0.012
        b.vx = (b.vx + ax) * 0.9
        b.vy = (b.vy + ay) * 0.9
        b.x += b.vx
        b.y += b.vy
        const speed = Math.min(1, Math.hypot(b.vx, b.vy) / 6)
        ctx.globalAlpha = 0.45 + speed * 0.5
        ctx.fillStyle = b.warm ? '#f4c88c' : '#a9c6f2'
        ctx.fillRect(b.x, b.y, 1.6, 1.6)
      }
      ctx.globalAlpha = 1
      if (!reduce) raf = requestAnimationFrame(frame)
    }
    frame()
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])
  return <canvas ref={ref} className='absolute inset-0 h-full w-full' />
}
