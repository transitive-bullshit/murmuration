import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import * as THREE from 'three'

import { particleFragment, particleVertex } from './particleShader'

export interface Layout {
  /** changes whenever the target arrangement changes */
  key: string
  position: Float32Array
  color: Float32Array
  size: Float32Array
  alpha: Float32Array
  /** per-particle start delay, 0..1, used for the sweeping stagger */
  delay: Float32Array
  /** particle glyph: 0 = glowing disc, 1 = rounded tile */
  glyph: number
  spread?: number
  swirl?: number
  duration?: number
  shimmer?: number
}

export interface FieldHandle {
  count: number
  /** settled target positions (valid for picking once `settled`) */
  position: Float32Array
  size: Float32Array
  /** target layout alpha; 0 means hidden by the view itself */
  alpha: Float32Array
  vis: Float32Array
  /** bumps whenever targets change, so pickers can invalidate */
  version: () => number
  settled: () => boolean
  object: () => THREE.Object3D | null
}

const easeInOut = (x: number) =>
  x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2

interface Props {
  count: number
  layout: Layout
  vis: Float32Array
  visKey: string
  hover: number
  selected: number
  gain?: number
  minPx?: number
  handle?: RefObject<FieldHandle | null>
  /** where particles start on first mount */
  origin?: [number, number, number]
}

export function ParticleField({
  count,
  layout,
  vis,
  visKey,
  hover,
  selected,
  gain = 1,
  minPx = 1.6,
  handle,
  origin = [0, 0, 0]
}: Props) {
  const meshRef = useRef<THREE.Mesh>(null)
  const size = useThree((s) => s.size)

  const { geometry, attrs } = useMemo(() => {
    const geometry = new THREE.InstancedBufferGeometry()
    const quad = new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0
    ])
    geometry.setAttribute('position', new THREE.BufferAttribute(quad, 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    const make = (itemSize: number) => {
      const attr = new THREE.InstancedBufferAttribute(
        new Float32Array(count * itemSize),
        itemSize
      )
      attr.setUsage(THREE.DynamicDrawUsage)
      return attr
    }
    const attrs = {
      aFrom: make(3),
      aTo: make(3),
      aColorFrom: make(3),
      aColorTo: make(3),
      aSize: make(2),
      aAlpha: make(2),
      aVis: make(2),
      aMeta: make(2),
      aIndex: make(1)
    }
    for (const [name, attr] of Object.entries(attrs))
      geometry.setAttribute(name, attr)
    for (let i = 0; i < count; i++) attrs.aIndex.array[i] = i
    geometry.instanceCount = count
    return { geometry, attrs }
  }, [count])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: particleVertex,
        fragmentShader: particleFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uT: { value: 0 },
          uVisT: { value: 1 },
          uTime: { value: 0 },
          uSpread: { value: 0.5 },
          uSwirl: { value: 1.2 },
          uGlyphFrom: { value: 0 },
          uGlyphTo: { value: 0 },
          uHover: { value: -1 },
          uSelected: { value: -1 },
          uViewportH: { value: 800 },
          uMinPx: { value: minPx },
          uGain: { value: gain },
          uShimmer: { value: 0.01 }
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // These GPU resources are created imperatively, so release them ourselves.
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  const state = useRef<{
    initialized: boolean
    progress: number
    duration: number
    spread: number
    visT: number
    glyphTo: number
    glyphFrom: number
    version: number
    target: {
      position: Float32Array
      size: Float32Array
      alpha: Float32Array
      vis: Float32Array
    }
  }>({
    initialized: false,
    progress: 0,
    duration: 3.2,
    spread: 0.5,
    visT: 1,
    glyphTo: 0,
    glyphFrom: 0,
    version: 0,
    target: {
      position: new Float32Array(count * 3),
      size: new Float32Array(count),
      alpha: new Float32Array(count),
      vis: new Float32Array(count)
    }
  })

  // Re-target the morph whenever the layout changes, starting from wherever
  // each particle currently is (so interrupted transitions stay continuous).
  useEffect(() => {
    const s = state.current
    const { aFrom, aTo, aColorFrom, aColorTo, aSize, aAlpha, aMeta } = attrs
    const from = aFrom.array as Float32Array
    const to = aTo.array as Float32Array
    const cFrom = aColorFrom.array as Float32Array
    const cTo = aColorTo.array as Float32Array
    const sz = aSize.array as Float32Array
    const al = aAlpha.array as Float32Array
    const meta = aMeta.array as Float32Array

    if (!s.initialized) {
      for (let i = 0; i < count; i++) {
        const r = 0.15 * Math.cbrt(((i * 2654435761) % 1000) / 1000)
        const th = i * 2.399963
        const ph = Math.acos(1 - (2 * ((i * 40503) % 997)) / 997)
        from[i * 3] = origin[0] + r * Math.sin(ph) * Math.cos(th)
        from[i * 3 + 1] = origin[1] + r * Math.cos(ph)
        from[i * 3 + 2] = origin[2] + r * Math.sin(ph) * Math.sin(th)
        cFrom[i * 3] = layout.color[i * 3]! * 2
        cFrom[i * 3 + 1] = layout.color[i * 3 + 1]! * 2
        cFrom[i * 3 + 2] = layout.color[i * 3 + 2]! * 2
        sz[i * 2] = layout.size[i]! * 0.4
        al[i * 2] = 0
        meta[i * 2] = ((i * 2246822519) % 10007) / 10007
      }
      s.initialized = true
      s.glyphFrom = layout.glyph
    } else {
      const t = s.progress
      for (let i = 0; i < count; i++) {
        const p = Math.min(
          1,
          Math.max(0, t * (1 + s.spread) - meta[i * 2 + 1]! * s.spread)
        )
        const e = easeInOut(p)
        for (let k = 0; k < 3; k++) {
          const j = i * 3 + k
          from[j] = from[j]! + (to[j]! - from[j]!) * e
          cFrom[j] = cFrom[j]! + (cTo[j]! - cFrom[j]!) * e
        }
        sz[i * 2] = sz[i * 2]! + (sz[i * 2 + 1]! - sz[i * 2]!) * e
        al[i * 2] = al[i * 2]! + (al[i * 2 + 1]! - al[i * 2]!) * e
      }
      s.glyphFrom =
        s.glyphFrom + (s.glyphTo - s.glyphFrom) * easeInOut(Math.min(1, t))
    }

    to.set(layout.position)
    cTo.set(layout.color)
    for (let i = 0; i < count; i++) {
      sz[i * 2 + 1] = layout.size[i]!
      al[i * 2 + 1] = layout.alpha[i]!
      meta[i * 2 + 1] = layout.delay[i]!
    }
    s.target.position = layout.position
    s.target.size = layout.size
    s.target.alpha = layout.alpha
    s.version++
    s.glyphTo = layout.glyph
    s.progress = 0
    s.duration = layout.duration ?? 2.4
    s.spread = layout.spread ?? 0.45

    const u = material.uniforms
    u.uSpread!.value = s.spread
    u.uSwirl!.value = layout.swirl ?? 1
    u.uShimmer!.value = layout.shimmer ?? 0.01
    u.uGlyphFrom!.value = s.glyphFrom
    u.uGlyphTo!.value = s.glyphTo
    for (const attr of [aFrom, aTo, aColorFrom, aColorTo, aSize, aAlpha, aMeta])
      attr.needsUpdate = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, count])

  useEffect(() => {
    const s = state.current
    const v = attrs.aVis.array as Float32Array
    const e = easeInOut(Math.min(1, s.visT))
    for (let i = 0; i < count; i++) {
      v[i * 2] = v[i * 2]! + (v[i * 2 + 1]! - v[i * 2]!) * e
      v[i * 2 + 1] = vis[i] ?? 1
    }
    s.target.vis = vis
    s.version++
    s.visT = 0
    attrs.aVis.needsUpdate = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visKey, count])

  useEffect(() => {
    if (!handle) return
    handle.current = {
      count,
      get position() {
        return state.current.target.position
      },
      get size() {
        return state.current.target.size
      },
      get alpha() {
        return state.current.target.alpha
      },
      version: () => state.current.version,
      get vis() {
        return state.current.target.vis
      },
      settled: () => state.current.progress >= 1,
      object: () => meshRef.current
    }
  }, [handle, count])

  useFrame((_, delta) => {
    const s = state.current
    const u = material.uniforms
    const dt = Math.min(delta, 1 / 20)
    s.progress = Math.min(1, s.progress + dt / s.duration)
    s.visT = Math.min(1, s.visT + dt / 0.6)
    u.uT!.value = s.progress
    u.uVisT!.value = s.visT
    u.uTime!.value += dt
    u.uHover!.value = hover
    u.uSelected!.value = selected
    u.uViewportH!.value = size.height
    u.uGain!.value = gain
    u.uMinPx!.value = minPx

    // Glowing discs blend additively (order-independent); solid tiles need
    // depth so stacks occlude correctly. Swap halfway through a morph.
    const tiles =
      s.glyphTo > 0.5
        ? s.progress > 0.55
        : s.progress < 0.45 && s.glyphFrom > 0.5
    const blending = tiles ? THREE.NormalBlending : THREE.AdditiveBlending
    if (material.blending !== blending) {
      material.blending = blending
      material.depthWrite = tiles
      material.needsUpdate = true
    }
  })

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={tilesOrder(layout.glyph)}
    />
  )
}

const tilesOrder = (glyph: number) => (glyph > 0.5 ? 0 : 1)
