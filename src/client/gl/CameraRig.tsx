import { CameraControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type ComponentRef } from 'react'
import * as THREE from 'three'

import { useApp, type ViewId } from '../store'

type CameraControlsImpl = ComponentRef<typeof CameraControls>
type V3 = [number, number, number]
export type Pose = { position: V3; target: V3 }

interface Framing {
  target: V3
  /** direction from target toward the camera */
  dir: V3
  /** world-space width × height that must fit on screen */
  frame: [number, number]
}

const FRAMINGS: Record<ViewId, Framing> = {
  constellation: { target: [0, 0, 0], dir: [0.04, 0.17, 1], frame: [17, 14] },
  strata: { target: [0.6, 2.6, 0], dir: [-0.07, 0.3, 1], frame: [30, 10] },
  growth: { target: [0, 4.7, 0], dir: [0, 0.08, 1], frame: [28.2, 11.4] },
  bangers: { target: [0, 4.7, 0], dir: [0, 0.08, 1], frame: [28.4, 11.6] },
  anatomy: { target: [0, 2, 0], dir: [0, 0.2, 1], frame: [26.5, 7.6] },
  orbit: { target: [0, -0.6, 0], dir: [0, 0.78, 1], frame: [23.5, 15] }
}

// Zoom strength per unit of wheel delta (log scale). Trackpad pinches arrive
// as ctrl+wheel with small deltas; mouse wheels as big notches.
const PINCH_ZOOM = 0.019
const WHEEL_ZOOM = 0.0018
// How quickly queued zoom is applied (seconds, exponential smoothing).
const ZOOM_SMOOTHING = 0.07
const MIN_DISTANCE = 2.5
const MAX_DISTANCE = 60
// A wheel gesture ends after this much quiet; its device class is decided once.
const GESTURE_GAP_MS = 220

const AUTO_ROTATE: Partial<Record<ViewId, number>> = {
  constellation: 0.035,
  orbit: 0.02
}

/** Width in CSS px taken by the left insight panel (0 on narrow screens). */
export const leftPanelWidth = (width: number) => (width >= 1100 ? 362 : 0)

/**
 * Glides between view poses, fitting each scene to the free screen area, and
 * owns wheel input:
 *
 * - pinch, ⌘/ctrl + scroll, or a mouse wheel zooms toward the exact point
 *   under the cursor (the hovered particle when there is one), which stays
 *   pinned to the same pixel for the whole gesture;
 * - two-finger trackpad scrolling pans, like a map;
 * - drag orbits; right-drag or shift-drag pans (camera-controls).
 */
export function CameraRig({
  focus,
  anchorFor
}: {
  focus?: Pose
  /** world point under the cursor if a particle is hovered */
  anchorFor?: () => THREE.Vector3 | undefined
}) {
  const ref = useRef<CameraControlsImpl>(null)
  const view = useApp((s) => s.view)
  const home = useApp((s) => s.cameraHome)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const gl = useThree((s) => s.gl)
  const connected = useThree((s) => s.events.connected) as
    | HTMLElement
    | undefined
  const lastInteraction = useRef(0)
  const panel = leftPanelWidth(size.width)
  const zoom = useRef({ pending: 0, anchor: new THREE.Vector3() })
  const anchorRef = useRef(anchorFor)
  useEffect(() => {
    anchorRef.current = anchorFor
  }, [anchorFor])

  // Shift the projection center right so scenes center in the space beside
  // the insight panel instead of underneath it.
  useEffect(() => {
    if (panel > 0)
      camera.setViewOffset(
        size.width,
        size.height,
        -panel / 2,
        0,
        size.width,
        size.height
      )
    else camera.clearViewOffset()
    camera.updateProjectionMatrix()
  }, [camera, size.width, size.height, panel])

  useEffect(() => {
    const controls = ref.current
    if (!controls) return
    const pose =
      focus ??
      fitPose(FRAMINGS[view], camera.fov, (size.width - panel) / size.height)
    zoom.current.pending = 0
    controls.smoothTime = 0.85
    void controls.setLookAt(...pose.position, ...pose.target, true)
    const settle = setTimeout(() => {
      controls.smoothTime = 0.25
    }, 1800)
    return () => clearTimeout(settle)
  }, [view, home, focus, camera, size.width, size.height, panel])

  useEffect(() => {
    const controls = ref.current
    if (!controls) return
    const mark = () => {
      lastInteraction.current = performance.now()
    }
    controls.addEventListener('controlstart', mark)
    controls.addEventListener('control', mark)
    return () => {
      controls.removeEventListener('controlstart', mark)
      controls.removeEventListener('control', mark)
    }
  }, [])

  // We handle the wheel ourselves; shift turns a left-drag into a pan.
  useEffect(() => {
    const controls = ref.current
    if (!controls) return
    type Buttons = CameraControlsImpl['mouseButtons']
    const { ACTION } = controls.constructor as unknown as {
      ACTION: {
        NONE: Buttons['wheel']
        ROTATE: Buttons['left']
        TRUCK: Buttons['left']
      }
    }
    controls.mouseButtons.wheel = ACTION.NONE
    const setPan = (pan: boolean) => {
      controls.mouseButtons.left = pan ? ACTION.TRUCK : ACTION.ROTATE
    }
    const onKey = (e: KeyboardEvent) => setPan(e.shiftKey)
    const onBlur = () => setPan(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    const el = connected ?? gl.domElement
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const plane = new THREE.Plane()
    const forward = new THREE.Vector3()
    const target = new THREE.Vector3()
    let lastWheel = 0
    let gestureIsMouse = false
    let anchorX = Number.NaN
    let anchorY = Number.NaN

    // The world point under the cursor: the hovered particle if any,
    // otherwise where the cursor ray meets the plane through the orbit
    // target facing the camera.
    const anchorAt = (e: WheelEvent, out: THREE.Vector3) => {
      const hovered = anchorRef.current?.()
      if (hovered) return out.copy(hovered)
      const rect = gl.domElement.getBoundingClientRect()
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      )
      raycaster.setFromCamera(ndc, camera)
      ref.current?.getTarget(target)
      camera.getWorldDirection(forward)
      plane.setFromNormalAndCoplanarPoint(forward, target)
      return raycaster.ray.intersectPlane(plane, out) ?? out.copy(target)
    }

    const onWheel = (e: WheelEvent) => {
      const controls = ref.current
      if (!controls) return
      e.preventDefault()
      lastInteraction.current = performance.now()

      const now = performance.now()
      const newGesture = now - lastWheel > GESTURE_GAP_MS
      if (newGesture) {
        // Decide once per gesture: line-based or big integer notches with no
        // horizontal component are a mouse wheel; anything else a trackpad.
        gestureIsMouse =
          e.deltaMode !== 0 ||
          (e.deltaX === 0 &&
            Number.isInteger(e.deltaY) &&
            Math.abs(e.deltaY) >= 50)
      }
      lastWheel = now
      const pixels = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      const dx = e.deltaX * pixels
      const dy = e.deltaY * pixels

      if (e.ctrlKey || e.metaKey || gestureIsMouse) {
        const strength = e.ctrlKey && !gestureIsMouse ? PINCH_ZOOM : WHEEL_ZOOM
        // Lock the anchor for the whole gesture unless the cursor moves.
        const moved = Math.hypot(e.clientX - anchorX, e.clientY - anchorY) > 3
        if (newGesture || moved || Number.isNaN(anchorX)) {
          anchorAt(e, zoom.current.anchor)
          anchorX = e.clientX
          anchorY = e.clientY
        }
        zoom.current.pending += dy * strength
        return
      }

      // Two-finger scroll pans: content follows the fingers 1:1 at the
      // depth of the orbit target.
      controls.getTarget(target)
      const distance = camera.position.distanceTo(target)
      const worldPerPx =
        (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) /
        size.height
      void controls.truck(dx * worldPerPx, dy * worldPerPx, false)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [connected, gl, camera, size.height])

  const position = useRef(new THREE.Vector3())
  const target = useRef(new THREE.Vector3())

  useFrame((_, delta) => {
    const controls = ref.current
    if (!controls) return

    // Apply queued zoom as a scaling about the anchor point: both camera and
    // target move toward it, so it keeps its exact spot on screen.
    const z = zoom.current
    if (Math.abs(z.pending) > 1e-4) {
      const step = z.pending * (1 - Math.exp(-delta / ZOOM_SMOOTHING))
      z.pending -= step
      controls.getPosition(position.current)
      controls.getTarget(target.current)
      const distance = position.current.distanceTo(target.current)
      const scale = THREE.MathUtils.clamp(
        Math.exp(step),
        MIN_DISTANCE / distance,
        MAX_DISTANCE / distance
      )
      if (Math.abs(scale - 1) < 1e-5) z.pending = 0
      const a = z.anchor
      position.current.sub(a).multiplyScalar(scale).add(a)
      target.current.sub(a).multiplyScalar(scale).add(a)
      void controls.setLookAt(
        position.current.x,
        position.current.y,
        position.current.z,
        target.current.x,
        target.current.y,
        target.current.z,
        false
      )
    }

    const speed = AUTO_ROTATE[view]
    if (!speed || focus) return
    if (performance.now() - lastInteraction.current < 5000) return
    controls.azimuthAngle += delta * speed
  })

  return (
    <CameraControls
      ref={ref}
      makeDefault
      minDistance={MIN_DISTANCE}
      maxDistance={MAX_DISTANCE}
      truckSpeed={1.2}
      draggingSmoothTime={0.12}
    />
  )
}

function fitPose(f: Framing, fovDeg: number, aspect: number): Pose {
  const tan = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)
  const dist =
    Math.max(
      f.frame[0] / 2 / (tan * Math.max(0.5, aspect)),
      f.frame[1] / 2 / tan
    ) * 1.04
  const d = new THREE.Vector3(...f.dir).normalize().multiplyScalar(dist)
  return {
    position: [f.target[0] + d.x, f.target[1] + d.y, f.target[2] + d.z],
    target: f.target
  }
}
