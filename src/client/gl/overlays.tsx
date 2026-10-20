import { QuadraticBezierLine } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import * as THREE from 'three'

import { displayText, fmtCompact, fmtMonth } from '../data/format'
import { TIME_WIDTH, type Model } from '../data/model'
import type { AnatomyStats } from '../layouts/anatomy'
import { BANGER_HEIGHT, OUTLIER_CAP, type Bangers } from '../layouts/bangers'
import {
  ENG_HEIGHT,
  FOLLOWERS_BASE,
  FOLLOWERS_HEIGHT,
  engY,
  logTicks
} from '../layouts/common'
import { ORBIT, arrivalTime } from '../layouts/people'
import type { StrataGeometry } from '../layouts/tweets'
import { useApp } from '../store'
import { LabelLayer, type SceneLabel } from './LabelLayer'
import { AreaFill, FadeLine, RevealLine, useReveal } from './primitives'

type V3 = [number, number, number]
const WEEK = 7 * 86_400
const X0 = -TIME_WIDTH / 2
const X1 = TIME_WIDTH / 2
/** Axis labels outrank data labels so the frame never disappears. */
const AXIS = 1e9

const label = (
  key: string,
  position: V3,
  node: ReactNode,
  opts: Partial<SceneLabel> = {}
): SceneLabel => ({
  key,
  position,
  node,
  priority: AXIS,
  ...opts
})

const tick = (text: string) => (
  <span className='block text-[10px] text-ink-3 tabular'>{text}</span>
)

function yearLabels(model: Model, y: number, z: number): SceneLabel[] {
  const years = model.years
    .map((year) => ({ year, x: model.timeToX(Date.UTC(year, 0, 1) / 1000) }))
    .filter((d) => d.x >= X0 - 1e-6)
  const step = (X1 - X0) / Math.max(1, years.length)
  return years.map(({ year, x }) =>
    label(
      `y${year}`,
      [x + step / 2, y, z],
      <span className='text-[11px] font-medium tracking-wide text-ink-3 tabular'>
        {year}
      </span>
    )
  )
}

/** Floor axis line with year ticks shared by Strata and Growth. */
function TimeAxisLines({
  model,
  z = 0,
  y = 0
}: {
  model: Model
  z?: number
  y?: number
}) {
  return (
    <group>
      <FadeLine
        points={[
          [X0, y, z],
          [X1, y, z]
        ]}
        opacity={0.22}
      />
      {model.years.map((year) => {
        const x = model.timeToX(Date.UTC(year, 0, 1) / 1000)
        if (x < X0 - 1e-6) return null
        return (
          <FadeLine
            key={year}
            points={[
              [x, y, z - 0.08],
              [x, y, z + 0.08]
            ]}
            opacity={0.35}
          />
        )
      })}
    </group>
  )
}

export function ConstellationOverlay({ model }: { model: Model }) {
  const items = useMemo<SceneLabel[]>(
    () =>
      model.ds.clusters.map((c) => {
        const [x, y, z] = c.centroid
        const rgb = model.clusterColor[c.id]
        const color = rgb
          ? `rgb(${rgb.map((v) => Math.round(Math.min(1, Math.sqrt(v)) * 255)).join(',')})`
          : '#ccc'
        return {
          key: `c${c.id}`,
          position: [x * 8.6, y * 8.6 * 0.82, z * 8.6] as V3,
          priority: c.size,
          node: (
            <span
              className='flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium text-white/90 backdrop-blur-md'
              style={{
                background: 'rgb(8 9 12 / 0.42)',
                boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.07)'
              }}
            >
              <span
                className='size-1.5 rounded-full'
                style={{ background: color, boxShadow: `0 0 8px ${color}` }}
              />
              {c.label}
            </span>
          )
        }
      }),
    [model]
  )
  return <LabelLayer items={items} delay={1.6} />
}

export function StrataOverlay({
  model,
  geometry
}: {
  model: Model
  geometry: StrataGeometry
}) {
  const items = useMemo(
    () => [
      ...yearLabels(model, 0, geometry.frontDepth + 0.9),
      label(
        'mine',
        [X0 - 0.4, 0.3, geometry.frontDepth * 0.5 + 0.3],
        <span className='eyebrow'>Your tweets</span>,
        {
          anchor: 'right'
        }
      ),
      label(
        'likes',
        [X0 - 0.4, 0.3, -geometry.backDepth * 0.5 - 0.3],
        <span className='eyebrow'>Likes</span>,
        {
          anchor: 'right'
        }
      )
    ],
    [model, geometry]
  )
  return (
    <group>
      <TimeAxisLines model={model} />
      <FadeLine
        points={[
          [X0, 0, 0.3],
          [X0, 0, geometry.frontDepth + 0.3]
        ]}
        opacity={0.12}
      />
      <FadeLine
        points={[
          [X0, 0, -0.3],
          [X0, 0, -geometry.backDepth - 0.3]
        ]}
        opacity={0.12}
      />
      <LabelLayer items={items} delay={1} />
    </group>
  )
}

export function GrowthOverlay({ model }: { model: Model }) {
  const { series, inflections } = model.ds
  const focusId = useApp((s) => s.focusInflection)
  const setFocus = useApp((s) => s.setFocusInflection)
  const reveal = useReveal(X0 - 0.5, X1 + 0.5, 2.2, 0.7)

  const maxFollowers = Math.max(1, ...series.followers)
  const followerY = (f: number) =>
    FOLLOWERS_BASE + (f / maxFollowers) * FOLLOWERS_HEIGHT
  const followerPoints = useMemo<V3[]>(
    () =>
      series.t
        .map(
          (t, i) =>
            [model.timeToX(t + WEEK), followerY(series.followers[i]!), 0] as V3
        )
        .filter(([x]) => x >= X0 && x <= X1 + 0.01),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model]
  )
  const medianPoints = useMemo<V3[]>(() => {
    const logs = gaussianSmooth(
      series.medianLikes.map((m) => Math.log10(m + 1)),
      3
    )
    return series.t
      .map(
        (t, i) =>
          [
            model.timeToX(t + WEEK / 2),
            engY(logs[i]!, model.maxLogEng),
            0.2
          ] as V3
      )
      .filter(([x]) => x >= X0 && x <= X1)
  }, [model, series])

  const engTicks = logTicks(model.maxLogEng)
  const followerTicks = niceTicks(maxFollowers)

  const focused = inflections.find((f) => f.id === focusId)
  const beacons = useMemo(() => {
    const ranked = [...inflections].sort(
      (a, b) => b.gain - b.baseline - (a.gain - a.baseline)
    )
    const major = new Set(ranked.slice(0, 10).map((f) => f.id))
    return inflections
      .map((inf) => {
        const x = model.timeToX(inf.t + WEEK / 2)
        const i = Math.max(
          0,
          series.t.findIndex((t) => t >= inf.t)
        )
        const y =
          inf.metric === 'followers'
            ? followerY(series.followers[i] ?? 0)
            : ENG_HEIGHT + 0.3
        return {
          inf,
          x,
          y,
          major: major.has(inf.id),
          excess: inf.gain - inf.baseline,
          color: inf.metric === 'followers' ? '#bcd8ff' : '#ffd29a'
        }
      })
      .filter((b) => b.x >= X0 && b.x <= X1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, inflections, series])

  const items = useMemo<SceneLabel[]>(
    () => [
      ...yearLabels(model, 0, 1.4),
      ...engTicks.map((v) =>
        label(
          `e${v}`,
          [X0 - 0.3, engY(Math.log10(v + 1), model.maxLogEng), -0.6],
          tick(fmtCompact(v)),
          { anchor: 'right' }
        )
      ),
      ...followerTicks.map((v) =>
        label(`f${v}`, [X0 - 0.3, followerY(v), -0.2], tick(fmtCompact(v)), {
          anchor: 'right'
        })
      ),
      label(
        'eng-title',
        [X0, ENG_HEIGHT + 0.6, -0.6],
        <span>
          <span className='eyebrow'>Engagement per tweet</span>
          <span className='ml-2 text-[10.5px] text-ink-3'>
            likes + 2× reposts · log scale · amber line = rolling median
          </span>
        </span>,
        { anchor: 'left' }
      ),
      label(
        'f-title',
        [X0, FOLLOWERS_BASE + FOLLOWERS_HEIGHT + 0.6, -0.2],
        <span>
          <span className='eyebrow'>Followers</span>
          <span className='ml-2 text-[10.5px] text-ink-3'>
            reconstructed from your follower list
          </span>
        </span>,
        { anchor: 'left' }
      ),
      ...beacons.map((b) => {
        const isFocus = b.inf.id === focusId
        return {
          key: b.inf.id,
          position: [b.x, b.y, 0] as V3,
          priority: isFocus ? 1e12 : b.excess,
          interactive: true,
          anchor: 'bottom' as const,
          node: (
            <button
              type='button'
              onClick={() => setFocus(isFocus ? undefined : b.inf.id)}
              className={`pressable mb-3 cursor-pointer whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium tabular ${
                isFocus
                  ? 'bg-white text-black'
                  : 'glass text-white/90 hover:bg-white/15'
              }`}
            >
              {b.inf.kind === 'surge' ? '↗ ' : ''}
              {fmtMonth(b.inf.t)} · +{fmtCompact(b.inf.gain)}
            </button>
          )
        }
      })
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, beacons, focusId, setFocus]
  )

  return (
    <group>
      <TimeAxisLines model={model} />
      {engTicks.map((v) => {
        const y = engY(Math.log10(v + 1), model.maxLogEng)
        return (
          <FadeLine
            key={`e${v}`}
            points={[
              [X0, y, -0.6],
              [X1, y, -0.6]
            ]}
            opacity={0.06}
          />
        )
      })}
      <RevealLine
        points={medianPoints}
        color='#f0b26a'
        width={1.6}
        opacity={0.85}
        reveal={reveal}
      />

      {followerTicks.map((v) => (
        <FadeLine
          key={`f${v}`}
          points={[
            [X0, followerY(v), -0.2],
            [X1, followerY(v), -0.2]
          ]}
          opacity={0.06}
        />
      ))}
      <AreaFill
        points={followerPoints}
        base={FOLLOWERS_BASE}
        color='#4f8fe0'
        opacity={0.28}
        reveal={reveal}
      />
      <RevealLine
        points={followerPoints}
        color='#9cc6ff'
        width={2.2}
        reveal={reveal}
      />

      {beacons.map((b) => (
        <group key={b.inf.id}>
          <FadeLine
            points={[
              [b.x, 0, 0],
              [b.x, b.y, 0]
            ]}
            color={b.color}
            opacity={b.inf.id === focusId ? 0.6 : b.major ? 0.16 : 0.05}
            delay={1.6}
          />
          <mesh
            position={[b.x, b.y, 0]}
            scale={b.inf.id === focusId ? 1.6 : b.major ? 1 : 0.65}
          >
            <sphereGeometry args={[0.085, 20, 20]} />
            <meshBasicMaterial color={b.color} toneMapped={false} />
          </mesh>
        </group>
      ))}

      {focused && (
        <CauseArcs
          model={model}
          inflectionId={focused.id}
          followerY={followerY}
        />
      )}
      <LabelLayer items={items} delay={0.9} />
    </group>
  )
}

/** Arcs from the likeliest causal tweets up to the focused beacon. */
function CauseArcs({
  model,
  inflectionId,
  followerY
}: {
  model: Model
  inflectionId: string
  followerY: (f: number) => number
}) {
  const { series, inflections } = model.ds
  const inf = inflections.find((f) => f.id === inflectionId)!
  const x = model.timeToX(inf.t + WEEK / 2)
  const i = Math.max(
    0,
    series.t.findIndex((t) => t >= inf.t)
  )
  const target: V3 = [
    x,
    inf.metric === 'followers'
      ? followerY(series.followers[i] ?? 0)
      : ENG_HEIGHT + 0.3,
    0
  ]
  return (
    <group>
      {inf.causes
        .filter((c) => c.tweet >= 0)
        .map((c) => {
          const from: V3 = [
            model.timeToX(model.t[c.tweet]!),
            engY(model.logEng[c.tweet]!, model.maxLogEng),
            0
          ]
          const mid: V3 = [
            (from[0] + target[0]) / 2,
            Math.max(from[1], target[1]) + 1.2,
            0.6
          ]
          return (
            <QuadraticBezierLine
              key={c.tweet}
              start={from}
              end={target}
              mid={mid}
              color='#ffd8a0'
              lineWidth={1 + c.weight * 3}
              transparent
              opacity={0.35 + c.weight * 0.6}
              depthWrite={false}
              toneMapped={false}
            />
          )
        })}
    </group>
  )
}

export function AnatomyOverlay({
  model,
  stats
}: {
  model: Model
  stats: AnatomyStats
}) {
  const G = stats.buckets.length
  const spacing = Math.min(3.1, 24 / Math.max(1, G))
  const years = stats.years
  const depth = 0.5
  const zOf = (k: number) => (k - (years.length - 1) / 2) * depth
  const frontZ = zOf(years.length - 1) + 0.6
  const backZ = zOf(0) - 0.4
  const left = -((G - 1) / 2) * spacing - spacing / 2 - 0.4
  const yFor = (eng: number) => engY(Math.log10(eng + 1), model.maxLogEng)

  const items = useMemo<SceneLabel[]>(
    () => [
      ...logTicks(model.maxLogEng).map((v) =>
        label(`t${v}`, [left - 0.2, yFor(v), backZ], tick(fmtCompact(v)), {
          anchor: 'right'
        })
      ),
      ...years
        .map((y, k) => ({ y, k }))
        .filter(({ k }) => k % 2 === (years.length - 1) % 2)
        .map(({ y, k }) =>
          label(
            `y${y}`,
            [left - 0.2, 0, zOf(k)],
            <span className='text-[10px] text-ink-4 tabular'>{y}</span>,
            { anchor: 'right', priority: AXIS - 1 }
          )
        ),
      ...stats.buckets.map((b, g) =>
        label(
          `b${b.key}`,
          [(g - (G - 1) / 2) * spacing, -0.45, frontZ + 0.2],
          <span className='flex flex-col items-center gap-0.5'>
            <span className='flex items-center gap-1.5 text-[12px] font-semibold text-ink'>
              <span
                className='size-2 rounded-full'
                style={{ background: b.color }}
              />
              {b.label}
            </span>
            <span className='text-[10.5px] text-ink-3 tabular'>
              median {fmtCompact(b.medianEng)} · {fmtCompact(b.n)} tweets
            </span>
          </span>,
          { anchor: 'top', priority: AXIS + 1 }
        )
      )
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, stats]
  )

  return (
    <group key={stats.group}>
      {logTicks(model.maxLogEng).map((v) => (
        <FadeLine
          key={v}
          points={[
            [left, yFor(v), backZ],
            [-left, yFor(v), backZ]
          ]}
          opacity={0.06}
        />
      ))}
      {stats.buckets.map((b, g) => {
        const cx = (g - (G - 1) / 2) * spacing
        const half = spacing * 0.34
        const trend: V3[] = smoothTrend(
          b.byYear
            .map((y, k) =>
              y.n >= 8 ? ([cx, yFor(y.medianEng), zOf(k)] as V3) : null
            )
            .filter((p): p is V3 => !!p)
        )
        return (
          <group key={b.key}>
            <FadeLine
              points={[
                [cx - half, yFor(b.medianEng), frontZ],
                [cx + half, yFor(b.medianEng), frontZ]
              ]}
              color={b.color}
              opacity={0.9}
              width={2}
              delay={1.2}
            />
            {trend.length >= 2 && (
              <FadeLine
                points={trend}
                color='#fff1dc'
                opacity={0.28}
                width={1.2}
                delay={1.5}
              />
            )}
          </group>
        )
      })}
      <LabelLayer items={items} delay={0.9} />
    </group>
  )
}

export function OrbitOverlay({ model }: { model: Model }) {
  const playhead = useApp((s) => s.playhead)
  const handle = model.ds.meta.account.handle
  const [d0, d1] = model.domain
  const angleOf = (t: number) =>
    -(Math.min(1, Math.max(0, (t - d0) / (d1 - d0))) * 0.94 * Math.PI * 2) +
    Math.PI / 2
  const outer = ORBIT.followers + ORBIT.followersWidth + 0.35
  const rings = [
    { r: ORBIT.close, label: 'closest' },
    { r: ORBIT.mutual, label: 'mutuals' },
    { r: ORBIT.following, label: 'following' },
    { r: ORBIT.followers, label: 'followers' }
  ]

  const items = useMemo<SceneLabel[]>(() => {
    const { people } = model.ds
    const people36 = [...Array(people.n).keys()]
      .filter((p) => people.handle[p])
      .sort((a, b) => people.closeness[b]! - people.closeness[a]!)
      .slice(0, 36)
    return [
      label(
        'me',
        [0, -0.55, 0],
        <span className='text-[12px] font-semibold text-ink'>@{handle}</span>,
        { anchor: 'top', priority: AXIS + 1 }
      ),
      ...rings.map(({ r, label: text }) =>
        label(
          `r${text}`,
          [0, 0.05, r],
          <span className='eyebrow text-[9.5px]'>{text}</span>
        )
      ),
      ...model.years.map((y) => {
        const a = angleOf(Date.UTC(y, 0, 1) / 1000)
        return label(
          `y${y}`,
          [Math.cos(a) * (outer + 0.6), 0, Math.sin(a) * (outer + 0.6)],
          <span className='text-[10px] text-ink-3 tabular'>{y}</span>
        )
      }),
      ...(playhead === undefined
        ? people36.map((p) => ({
            key: `p${p}`,
            position: personPosition(model, p),
            priority: people.closeness[p]!,
            anchor: 'bottom' as const,
            node: (
              <span className='mb-1.5 block text-[10.5px] font-medium text-white/75'>
                @{people.handle[p]}
              </span>
            )
          }))
        : [])
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, playhead === undefined])

  return (
    <group>
      <mesh>
        <sphereGeometry args={[0.34, 48, 48]} />
        <meshBasicMaterial color='#ffe6c4' toneMapped={false} />
      </mesh>
      {rings.map(({ r, label: text }) => (
        <FadeLine key={text} points={ring(r)} opacity={0.07} />
      ))}
      {model.years.map((y) => {
        const a = angleOf(Date.UTC(y, 0, 1) / 1000)
        const c = Math.cos(a)
        const s = Math.sin(a)
        return (
          <FadeLine
            key={y}
            points={[
              [c * (outer - 0.15), 0, s * (outer - 0.15)],
              [c * (outer + 0.15), 0, s * (outer + 0.15)]
            ]}
            opacity={0.35}
          />
        )
      })}
      {playhead !== undefined && (
        <FadeLine
          points={[
            [0, 0, 0],
            [
              Math.cos(angleOf(playhead)) * outer,
              0,
              Math.sin(angleOf(playhead)) * outer
            ]
          ]}
          color='#ffe2b0'
          opacity={0.5}
          delay={0}
        />
      )}
      <LabelLayer items={items} delay={1.1} />
    </group>
  )
}

function ring(r: number, segments = 160): V3[] {
  return Array.from({ length: segments + 1 }, (_, k) => {
    const a = (k / segments) * Math.PI * 2
    return [Math.cos(a) * r, 0, Math.sin(a) * r]
  })
}

function personPosition(model: Model, p: number): V3 {
  const c = model.ds.people.closeness[p]!
  const [d0, d1] = model.domain
  const arrival = arrivalTime(model, p)
  const theta =
    arrival > 0
      ? -(
          Math.min(1, Math.max(0, (arrival - d0) / (d1 - d0))) *
          0.94 *
          Math.PI *
          2
        ) +
        Math.PI / 2
      : 0
  const r = ORBIT.inner + Math.pow(1 - c, 1.6) * (ORBIT.close - ORBIT.inner)
  return [Math.cos(theta) * r, 0.1, Math.sin(theta) * r]
}

/** Light 3-point smoothing so sparse yearly medians read as a trend. */
function smoothTrend(points: V3[]): V3[] {
  return points.map((p, k) => {
    const a = points[k - 1] ?? p
    const b = points[k + 1] ?? p
    return [p[0], (a[1] + 2 * p[1] + b[1]) / 4, p[2]] as V3
  })
}

function gaussianSmooth(values: number[], sigma: number): number[] {
  const radius = Math.ceil(sigma * 3)
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, k) =>
    Math.exp(-((k - radius) ** 2) / (2 * sigma * sigma))
  )
  return values.map((_, i) => {
    let sum = 0
    let wsum = 0
    for (let k = -radius; k <= radius; k++) {
      const v = values[i + k]
      if (v === undefined) continue
      sum += v * kernel[k + radius]!
      wsum += kernel[k + radius]!
    }
    return sum / wsum
  })
}

function niceTicks(max: number): number[] {
  const step = 10 ** Math.floor(Math.log10(max / 4))
  const nice =
    [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => max / s <= 5) ??
    step * 10
  const ticks: number[] = []
  for (let v = 0; v <= max; v += nice) ticks.push(v)
  return ticks
}

/**
 * Bangers — a lollipop chart through time: every standout tweet glows at the
 * top of a stem of light; the very best carry an excerpt label.
 */
export function BangersOverlay({
  model,
  bangers
}: {
  model: Model
  bangers: Bangers
}) {
  const flyTo = useApp((s) => s.flyTo)
  const engagement = bangers.mode === 'engagement'
  const stems = useRef<THREE.LineSegments>(null)
  const age = useRef(0)

  const geometry = useMemo(() => {
    const pos = new Float32Array(bangers.tops.length * 6)
    const col = new Float32Array(bangers.tops.length * 6)
    bangers.tops.forEach(([x, y, z], k) => {
      pos.set([x, 0, z, x, y, z], k * 6)
      const heat = 1 - k / Math.max(1, bangers.tops.length)
      const top = [1, 0.78 + heat * 0.15, 0.5 + heat * 0.35].map(
        (v) => v * (0.35 + heat * 0.65)
      )
      col.set([0, 0, 0, top[0]!, top[1]!, top[2]!], k * 6)
    })
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    return g
  }, [bangers])
  const material = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false
      }),
    []
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => {
    age.current = 0
  }, [bangers])

  // Stems grow up out of the floor once the particles have flown in.
  useFrame((_, dt) => {
    age.current += dt
    const t = Math.min(1, Math.max(0, (age.current - 0.9) / 1.4))
    const e = 1 - (1 - t) ** 3
    if (stems.current) stems.current.scale.y = Math.max(0.0001, e)
  })

  const ticks = engagement
    ? logTicks(Math.log10(10 ** bangers.maxLogEng)).filter((v) => v >= 10)
    : [2, 4, 6, 8, 10].filter((v) => v <= OUTLIER_CAP)
  const yOf = (v: number) =>
    engagement
      ? (Math.log10(v + 1) / bangers.maxLogEng) * BANGER_HEIGHT
      : (v / OUTLIER_CAP) * BANGER_HEIGHT * 0.96 + 0.04 * BANGER_HEIGHT

  const items = useMemo<SceneLabel[]>(() => {
    const labels: SceneLabel[] = [
      ...yearLabels(model, 0, 1.2),
      ...ticks.map((v) =>
        label(
          `t${v}`,
          [X0 - 0.3, yOf(v), -0.4],
          tick(engagement ? fmtCompact(v) : `+${v}σ`),
          { anchor: 'right' }
        )
      ),
      label(
        'title',
        [X0, BANGER_HEIGHT + 0.7, -0.4],
        <span>
          <span className='eyebrow'>
            {engagement ? 'Most engaging' : 'Biggest outliers'}
          </span>
          <span className='ml-2 text-[10.5px] text-ink-3'>
            {engagement
              ? 'likes + 2× reposts · log scale'
              : 'how far above your typical tweet at the time (robust z-score)'}
          </span>
        </span>,
        { anchor: 'left' }
      )
    ]
    bangers.ranked.slice(0, 18).forEach((i, k) => {
      const text = displayText(model.ds.tweets.text[i]!).replace(/\s+/g, ' ')
      const excerpt =
        text.length > 46 ? `${text.slice(0, 45).trimEnd()}…` : text
      labels.push({
        key: `b${i}`,
        position: bangers.tops[k]!,
        priority: 1000 - k,
        anchor: 'bottom',
        interactive: true,
        node: (
          <button
            type='button'
            onClick={() => flyTo({ type: 'tweet', index: i })}
            className='glass pressable mb-2.5 flex max-w-[260px] cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-left text-[11px] text-white/90 hover:bg-white/15'
          >
            <span className='shrink-0 font-semibold text-[#ffd59a] tabular'>
              {engagement
                ? `${fmtCompact(Math.max(0, model.likes[i]!))} ♥`
                : `+${model.outlier[i]!.toFixed(1)}σ`}
            </span>
            <span className='truncate'>{excerpt || '(media)'}</span>
          </button>
        )
      })
    })
    return labels
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, bangers, flyTo])

  return (
    <group>
      <TimeAxisLines model={model} />
      {ticks.map((v) => (
        <FadeLine
          key={`g${v}`}
          points={[
            [X0, yOf(v), -0.4],
            [X1, yOf(v), -0.4]
          ]}
          opacity={0.06}
        />
      ))}
      <lineSegments ref={stems} geometry={geometry} material={material} />
      <LabelLayer items={items} delay={1.6} />
    </group>
  )
}
