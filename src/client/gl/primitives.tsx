import { Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type ComponentRef } from 'react'
import * as THREE from 'three'

type Line2 = ComponentRef<typeof Line>

type V3 = [number, number, number]

/** A thin line that fades in after `delay` seconds. */
export function FadeLine({
  points,
  color = '#ffffff',
  opacity = 0.2,
  width = 1,
  delay = 0.6,
  dashed = false
}: {
  points: V3[]
  color?: string
  opacity?: number
  width?: number
  delay?: number
  dashed?: boolean
}) {
  const ref = useRef<Line2>(null)
  const age = useRef(0)
  useFrame((_, dt) => {
    age.current += dt
    const m = ref.current?.material
    if (!m) return
    const t = Math.min(1, Math.max(0, (age.current - delay) / 0.8))
    m.opacity = opacity * t * t * (3 - 2 * t)
  })
  return (
    <Line
      ref={ref}
      points={points}
      color={color}
      lineWidth={width}
      transparent
      opacity={0}
      depthWrite={false}
      dashed={dashed}
      dashSize={0.12}
      gapSize={0.1}
      toneMapped={false}
    />
  )
}

/** Soft additive area under a curve, revealed left → right. */
export function AreaFill({
  points,
  base,
  color,
  opacity = 0.18,
  reveal
}: {
  points: V3[]
  base: number
  color: string
  opacity?: number
  reveal: { current: number }
}) {
  const geometry = useMemo(() => {
    const pos: number[] = []
    const v: number[] = []
    const idx: number[] = []
    points.forEach(([x, y, z], k) => {
      pos.push(x, y, z, x, base, z)
      v.push(1, 0)
      if (k > 0) {
        const a = (k - 1) * 2
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    })
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aV', new THREE.Float32BufferAttribute(v, 1))
    g.setIndex(idx)
    return g
  }, [points, base])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Color(color) },
          uOpacity: { value: opacity },
          uReveal: { value: -100 }
        },
        vertexShader: /* glsl */ `
          attribute float aV;
          varying float vV;
          varying float vX;
          void main() {
            vV = aV;
            vX = position.x;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uOpacity;
          uniform float uReveal;
          varying float vV;
          varying float vX;
          void main() {
            if (vX > uReveal) discard;
            float edge = 1.0 - smoothstep(uReveal - 0.6, uReveal, vX);
            gl_FragColor = vec4(uColor, uOpacity * pow(clamp(vV, 0.0, 1.0), 1.6) * edge);
          }
        `
      }),
    [color, opacity]
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])
  const meshRef =
    useRef<THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>>(null)
  useFrame(() => {
    const uniform = meshRef.current?.material.uniforms.uReveal
    if (uniform) uniform.value = reveal.current
  })
  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      renderOrder={-1}
    />
  )
}

/** A polyline drawn progressively as `reveal` (world x) advances. */
export function RevealLine({
  points,
  color,
  width = 2,
  opacity = 1,
  reveal
}: {
  points: V3[]
  color: string
  width?: number
  opacity?: number
  reveal: { current: number }
}) {
  const ref = useRef<Line2>(null)
  const shown = useRef(-1)
  const flat = useMemo(() => points.flat(), [points])
  useFrame(() => {
    const line = ref.current
    if (!line) return
    let k = 0
    while (k < points.length && points[k]![0] <= reveal.current) k++
    k = Math.max(2, k)
    if (k === shown.current) return
    shown.current = k
    line.geometry.setPositions(flat.slice(0, k * 3))
    line.computeLineDistances()
  })
  return (
    <Line
      ref={ref}
      points={points.slice(0, 2)}
      color={color}
      lineWidth={width}
      transparent
      opacity={opacity}
      depthWrite={false}
      toneMapped={false}
    />
  )
}

/** Animates a number from `from` to `to` over `duration` seconds after `delay`. */
export function useReveal(
  from: number,
  to: number,
  duration = 1.6,
  delay = 0.4
) {
  const value = useRef(from)
  const age = useRef(0)
  useFrame((_, dt) => {
    age.current += dt
    const t = Math.min(1, Math.max(0, (age.current - delay) / duration))
    const e = 1 - (1 - t) ** 3
    value.current = from + (to - from) * e
  })
  return value
}
