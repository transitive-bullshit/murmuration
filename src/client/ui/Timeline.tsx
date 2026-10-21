import { useEffect, useMemo, useRef, useState } from 'react'

import { fmtMonth, fmtRange } from '../data/format'
import type { Model } from '../data/model'
import { useApp } from '../store'

const W = 1000
const H = 52

/**
 * Bottom scrubber. Everywhere: drag to filter a time range. In Orbit: drag or
 * press play to travel through time and watch your audience accrete.
 */
export function Timeline({ model }: { model: Model }) {
  const view = useApp((s) => s.view)
  const range = useApp((s) => s.range)
  const setRange = useApp((s) => s.setRange)
  const playhead = useApp((s) => s.playhead)
  const setPlayhead = useApp((s) => s.setPlayhead)
  const playing = useApp((s) => s.playing)
  const setPlaying = useApp((s) => s.setPlaying)
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null)
  const isOrbit = view === 'orbit'
  const [d0, d1] = model.domain
  const tToX = (t: number) => ((t - d0) / (d1 - d0)) * W
  const xToT = (x: number) => d0 + (Math.min(W, Math.max(0, x)) / W) * (d1 - d0)

  const paths = useMemo(() => {
    const { series } = model.ds
    const idx = series.t.map((t, i) => i).filter((i) => series.t[i]! >= d0)
    // Square-root scale keeps quiet years visible next to busy ones.
    const sq = (v: number) => Math.sqrt(v)
    const maxLikes = Math.max(1, ...idx.map((i) => sq(series.likesGiven[i]!)))
    const maxPosts = Math.max(
      1,
      ...idx.map((i) => sq(series.posts[i]! + series.replies[i]!))
    )
    const max = Math.max(maxLikes, maxPosts)
    const smooth = (arr: number[]) =>
      arr.map(
        (_, k) =>
          (arr[k - 1] ?? arr[k]!) * 0.25 +
          arr[k]! * 0.5 +
          (arr[k + 1] ?? arr[k]!) * 0.25
      )
    const likes = smooth(idx.map((i) => sq(series.likesGiven[i]!)))
    const posts = smooth(
      idx.map((i) => sq(series.posts[i]! + series.replies[i]!))
    )
    const xs = idx.map((i) => tToX(series.t[i]! + 3.5 * 86400))
    const y = (v: number) => H - 2 - (v / max) * (H - 8)
    const line = (vals: number[]) =>
      vals
        .map(
          (v, k) => `${k ? 'L' : 'M'}${xs[k]!.toFixed(1)},${y(v).toFixed(1)}`
        )
        .join('')
    return { likes: `${line(likes)}L${W},${H}L0,${H}Z`, posts: line(posts) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  // Orbit playback: sweep the whole history in ~22 seconds.
  useEffect(() => {
    if (!playing || !isOrbit) return
    let raf = 0
    let last = performance.now()
    let cur = useApp.getState().playhead ?? d0
    let lastSet = 0
    const tick = (now: number) => {
      // Capped, so a hidden tab or a stall resumes playback where it was.
      const dt = Math.min((now - last) / 1000, 1 / 20)
      last = now
      const s = useApp.getState()
      cur += ((d1 - d0) / 22) * dt
      if (cur >= d1) {
        s.setPlayhead(undefined)
        s.setPlaying(false)
        return
      }
      // ~20 layout updates per second is plenty; particles glide in between.
      if (now - lastSet > 50) {
        lastSet = now
        s.setPlayhead(cur)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, isOrbit, d0, d1])

  const eventX = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return ((e.clientX - rect.left) / rect.width) * W
  }

  const shown = drag
    ? ([Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)] as const)
    : range
      ? ([tToX(range[0]), tToX(range[1])] as const)
      : null
  const years = model.years
    .map((y) => ({ y, x: tToX(Date.UTC(y, 0, 1) / 1000) }))
    .filter((y) => y.x >= 0 && y.x <= W)

  return (
    <div className='pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4'>
      <div className='glass pointer-events-auto flex w-[min(920px,100%)] items-center gap-3 rounded-[22px] py-2 pl-2 pr-4'>
        {isOrbit ? (
          <button
            type='button'
            onClick={() => {
              if (!playing && (playhead === undefined || playhead >= d1))
                setPlayhead(d0)
              setPlaying(!playing)
            }}
            className='pressable flex size-10 shrink-0 items-center justify-center rounded-full bg-white/[0.09] text-ink hover:bg-white/[0.14]'
            aria-label={playing ? 'Pause' : 'Play through time'}
            title='Travel through time (space)'
          >
            {playing ? (
              <svg viewBox='0 0 16 16' className='size-3.5' fill='currentColor'>
                <rect x='3.5' y='3' width='3' height='10' rx='1' />
                <rect x='9.5' y='3' width='3' height='10' rx='1' />
              </svg>
            ) : (
              <svg
                viewBox='0 0 16 16'
                className='ml-0.5 size-3.5'
                fill='currentColor'
              >
                <path d='M4.5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.4 2.7a.6.6 0 0 0-.9.5Z' />
              </svg>
            )}
          </button>
        ) : (
          <div className='flex w-[132px] shrink-0 flex-col pl-2.5'>
            <span className='eyebrow'>{range ? 'Range' : 'All time'}</span>
            <span className='mt-1 truncate text-[11.5px] text-ink-2 tabular'>
              {range ? fmtRange(range[0], range[1]) : `${fmtMonth(d0)} – now`}
            </span>
          </div>
        )}

        <div className='relative min-w-0 flex-1'>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H + 14}`}
            preserveAspectRatio='none'
            className='block h-[66px] w-full cursor-crosshair touch-none'
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              const x = eventX(e)
              if (isOrbit) {
                setPlaying(false)
                setPlayhead(xToT(x))
              } else setDrag({ a: x, b: x })
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
              const x = eventX(e)
              if (isOrbit) setPlayhead(xToT(x))
              else setDrag((d) => (d ? { ...d, b: x } : d))
            }}
            onPointerUp={() => {
              if (isOrbit || !drag) return
              const [a, b] = [
                Math.min(drag.a, drag.b),
                Math.max(drag.a, drag.b)
              ]
              setDrag(null)
              if (b - a < 6) setRange(undefined)
              else setRange([xToT(a), xToT(b)])
            }}
            onDoubleClick={() =>
              isOrbit ? setPlayhead(undefined) : setRange(undefined)
            }
          >
            <defs>
              <linearGradient id='tl-likes' x1='0' x2='0' y1='0' y2='1'>
                <stop offset='0%' stopColor='#3987e5' stopOpacity='0.45' />
                <stop offset='100%' stopColor='#3987e5' stopOpacity='0.02' />
              </linearGradient>
            </defs>
            {years.map(({ y, x }) => (
              <g key={y}>
                <line
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={H}
                  stroke='white'
                  strokeOpacity='0.06'
                  vectorEffect='non-scaling-stroke'
                />
                <text
                  x={x + 4}
                  y={H + 11}
                  fontSize='10'
                  fill='#7c7b75'
                  className='tabular'
                  style={{ fontFamily: 'var(--font-sans)' }}
                >
                  {y}
                </text>
              </g>
            ))}
            <path d={paths.likes} fill='url(#tl-likes)' />
            <path
              d={paths.posts}
              fill='none'
              stroke='#e8834f'
              strokeWidth='1.3'
              strokeOpacity='0.9'
              vectorEffect='non-scaling-stroke'
            />
            {!isOrbit && shown && (
              <g>
                <rect
                  x={0}
                  y={0}
                  width={shown[0]}
                  height={H}
                  fill='#030406'
                  fillOpacity='0.55'
                />
                <rect
                  x={shown[1]}
                  y={0}
                  width={W - shown[1]}
                  height={H}
                  fill='#030406'
                  fillOpacity='0.55'
                />
                <line
                  x1={shown[0]}
                  x2={shown[0]}
                  y1={0}
                  y2={H}
                  stroke='#ffe2b0'
                  strokeWidth='1.5'
                  vectorEffect='non-scaling-stroke'
                />
                <line
                  x1={shown[1]}
                  x2={shown[1]}
                  y1={0}
                  y2={H}
                  stroke='#ffe2b0'
                  strokeWidth='1.5'
                  vectorEffect='non-scaling-stroke'
                />
              </g>
            )}
            {isOrbit && playhead !== undefined && (
              <g>
                <rect
                  x={tToX(playhead)}
                  y={0}
                  width={W - tToX(playhead)}
                  height={H}
                  fill='#030406'
                  fillOpacity='0.6'
                />
                <line
                  x1={tToX(playhead)}
                  x2={tToX(playhead)}
                  y1={0}
                  y2={H}
                  stroke='#ffe2b0'
                  strokeWidth='1.5'
                  vectorEffect='non-scaling-stroke'
                />
              </g>
            )}
          </svg>
          {isOrbit && playhead !== undefined && (
            <div
              className='pointer-events-none absolute -top-7 -translate-x-1/2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-black tabular'
              style={{ left: `${(tToX(playhead) / W) * 100}%` }}
            >
              {fmtMonth(playhead)}
            </div>
          )}
        </div>

        <div className='hidden shrink-0 flex-col items-end gap-1 text-[10.5px] text-ink-3 md:flex'>
          <span className='flex items-center gap-1.5'>
            <span className='h-px w-3 bg-[#e8834f]' />
            your tweets / wk
          </span>
          <span className='flex items-center gap-1.5'>
            <span className='h-2 w-3 rounded-sm bg-[#3987e5]/40' />
            likes / wk
          </span>
        </div>
      </div>
    </div>
  )
}
