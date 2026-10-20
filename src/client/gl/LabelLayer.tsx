import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as THREE from 'three'

export interface SceneLabel {
  key: string
  position: [number, number, number]
  /** higher wins when labels collide */
  priority: number
  node: ReactNode
  interactive?: boolean
  /** which part of the label sits on the point (default: center) */
  anchor?: 'center' | 'bottom' | 'top' | 'left' | 'right'
}

const PAD = 5

/**
 * DOM labels for scene points with greedy, priority-ordered collision
 * avoidance in screen space. Positions update every frame without React
 * re-renders; hidden labels fade rather than pop.
 */
export function LabelLayer({
  items,
  delay = 0.4
}: {
  items: SceneLabel[]
  delay?: number
}) {
  const { gl, camera, size } = useThree()
  const root = useRef<Root | null>(null)
  useEffect(() => {
    // A fresh container per mount, so a deferred unmount of a previous root
    // (StrictMode, fast view switches) can never clear the current labels.
    const container = document.createElement('div')
    container.style.cssText =
      'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:10'
    gl.domElement.parentElement?.appendChild(container)
    const r = createRoot(container)
    root.current = r
    return () => {
      if (root.current === r) root.current = null
      // Unmount after the current render pass to avoid React warnings.
      queueMicrotask(() => {
        r.unmount()
        container.remove()
      })
    }
  }, [gl])

  const nodes = useRef(new Map<string, HTMLDivElement>())
  const dims = useRef(new Map<string, [number, number]>())
  const born = useRef(0)
  const v = useRef(new THREE.Vector3())
  const sorted = useMemo(
    () => [...items].sort((a, b) => b.priority - a.priority),
    [items]
  )

  useFrame(() => {
    const placed: [number, number, number, number][] = []
    if (!born.current) born.current = performance.now()
    const ready = (performance.now() - born.current) / 1000 > delay
    for (const item of sorted) {
      const el = nodes.current.get(item.key)
      if (!el) continue
      let d = dims.current.get(item.key)
      if (!d || d[0] === 0) {
        d = [el.offsetWidth, el.offsetHeight]
        dims.current.set(item.key, d)
      }
      v.current.set(...item.position).project(camera)
      const behind = v.current.z > 1
      const x = (v.current.x * 0.5 + 0.5) * size.width
      const y = (-v.current.y * 0.5 + 0.5) * size.height
      const [w, h] = d
      const anchor = item.anchor ?? 'center'
      // Keep labels inside the viewport: slide them in from the edges as
      // long as the point they label is on screen; otherwise hide them.
      let left = anchor === 'right' ? x - w : anchor === 'left' ? x : x - w / 2
      let top = anchor === 'bottom' ? y - h : anchor === 'top' ? y : y - h / 2
      const offscreen =
        behind || x < 0 || x > size.width || y < 0 || y > size.height
      left = Math.min(Math.max(left, 4), size.width - w - 4)
      top = Math.min(Math.max(top, 4), size.height - h - 4)
      const box: [number, number, number, number] = [
        left - PAD,
        top - PAD,
        left + w + PAD,
        top + h + PAD
      ]
      const hit = placed.some(
        (b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]
      )
      const show = ready && !offscreen && !hit
      if (show) placed.push(box)
      el.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`
      el.style.opacity = show ? '1' : '0'
      el.style.pointerEvents = show && item.interactive ? 'auto' : 'none'
    }
  })

  // The label DOM lives in its own React root (R3F's reconciler can't host DOM).
  useEffect(() => {
    const nodeMap = nodes.current
    const dimMap = dims.current
    root.current?.render(
      <>
        {items.map((item) => (
          <div
            key={item.key}
            ref={(el) => {
              if (!el) return
              nodeMap.set(item.key, el)
              dimMap.delete(item.key)
              return () => {
                // Only forget this exact element; a newer root may own the key now.
                if (nodeMap.get(item.key) === el) {
                  nodeMap.delete(item.key)
                  dimMap.delete(item.key)
                }
              }
            }}
            className='absolute left-0 top-0 whitespace-nowrap'
            style={{
              opacity: 0,
              transition: 'opacity 260ms ease',
              willChange: 'transform, opacity'
            }}
          >
            {item.node}
          </div>
        ))}
      </>
    )
  }, [items])

  return null
}
