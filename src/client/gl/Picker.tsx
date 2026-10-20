import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type RefObject } from 'react'
import * as THREE from 'three'

import type { FieldHandle } from './ParticleField'

/**
 * CPU picking against the settled particle targets: project every visible
 * particle to screen space and take the nearest within its on-screen radius.
 * ~50k projections fit comfortably in a frame; they only run when the
 * pointer, camera, or particle targets change, and once more on click.
 */
export function Picker({
  field,
  enabled,
  onHover,
  onPick
}: {
  field: RefObject<FieldHandle | null>
  enabled: boolean
  onHover: (index: number) => void
  onPick: (index: number) => void
}) {
  const { camera, gl, size } = useThree()
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const dirty = useRef(false)
  const current = useRef(-1)
  const down = useRef<{ x: number; y: number } | null>(null)
  const viewProj = useRef(new THREE.Matrix4())
  const lastView = useRef(new THREE.Matrix4())
  const lastVersion = useRef(-1)
  const enabledRef = useRef(enabled)
  useEffect(() => {
    enabledRef.current = enabled
    dirty.current = true
  }, [enabled])

  // Nearest visible particle under (px, py) in CSS pixels, or -1.
  const pickAt = (px: number, py: number): number => {
    const f = field.current
    if (!f || !f.settled()) return -1
    const e = viewProj.current.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    ).elements
    const { position: pos, size: sz, alpha, vis } = f
    const halfW = size.width / 2
    const halfH = size.height / 2
    const pxPerUnit = camera.projectionMatrix.elements[5]! * halfH
    let best = -1
    let bestScore = Infinity
    for (let i = 0; i < f.count; i++) {
      if ((vis[i] ?? 1) < 0.5 || sz[i]! <= 0 || alpha[i]! <= 0.01) continue
      const x = pos[i * 3]!
      const y = pos[i * 3 + 1]!
      const z = pos[i * 3 + 2]!
      const w = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!
      if (w <= 0.1) continue
      const sx =
        ((e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) / w) * halfW + halfW
      const sy =
        -((e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) / w) * halfH + halfH
      const dx = sx - px
      const dy = sy - py
      const d2 = dx * dx + dy * dy
      const radius = Math.max(7, (sz[i]! * pxPerUnit) / w)
      if (d2 > radius * radius) continue
      // Prefer the closest to the pointer, breaking near-ties toward the camera.
      const score = d2 + w * 0.5
      if (score < bestScore) {
        bestScore = score
        best = i
      }
    }
    return best
  }
  const pickRef = useRef(pickAt)
  useEffect(() => {
    pickRef.current = pickAt
  })

  useEffect(() => {
    const el = gl.domElement
    const local = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }
    const move = (e: PointerEvent) => {
      pointer.current = local(e)
      dirty.current = true
    }
    const leave = () => {
      pointer.current = null
      dirty.current = true
    }
    const pdown = (e: PointerEvent) => {
      down.current = { x: e.clientX, y: e.clientY }
    }
    const up = (e: PointerEvent) => {
      const d = down.current
      down.current = null
      // Treat as a click only if the pointer barely moved (not an orbit drag),
      // and hit-test again: the scene may have moved since the last hover.
      if (!d || !enabledRef.current) return
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
      const p = local(e)
      onPick(pickRef.current(p.x, p.y))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('pointerdown', pdown)
    el.addEventListener('pointerup', up)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('pointerdown', pdown)
      el.removeEventListener('pointerup', up)
    }
  }, [gl, onPick])

  useFrame(() => {
    const f = field.current
    if (!f) return
    // Camera motion (including auto-rotate) or new targets invalidate the hit.
    if (!lastView.current.equals(camera.matrixWorldInverse)) {
      lastView.current.copy(camera.matrixWorldInverse)
      dirty.current = true
    }
    if (f.version() !== lastVersion.current) {
      lastVersion.current = f.version()
      dirty.current = true
    }
    if (!dirty.current) return
    const p = pointer.current
    const settled = f.settled()
    const next = enabled && p && settled ? pickAt(p.x, p.y) : -1
    // Stay dirty until targets settle so a pending hover resolves afterwards.
    dirty.current = !!p && enabled && !settled
    if (next !== current.current) {
      current.current = next
      onHover(next)
    }
  })

  return null
}
