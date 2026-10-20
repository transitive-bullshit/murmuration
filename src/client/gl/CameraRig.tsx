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
// The idle camera turns only after this long without any input (pointer,
// wheel, keys) or anything in focus…
const IDLE_MS = 8000
// …then eases in over this long, and stops the moment you're back.
const SPIN_UP_MS = 2500
// Closer than this share of the view's home distance counts as zoomed in.
const ZOOMED_IN = 0.8
// Orbit target this far from home (share of home distance) counts as panned
// to a sub-region.
const PANNED_AWAY = 0.2

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
 * - drag orbits; right-drag or shift-drag pans (camera-controls);
 * - Constellation and Orbit slowly turn on their own once you've been idle a
 *   while with nothing hovered, selected, focused or zoomed into.
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
  // Last frame something held the camera still (hover, selection, zoom).
  const lastEngaged = useRef(0)
  const spinning = useRef(false)
  const homePose = useRef<Pose | undefined>(undefined)
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
    const home = fitPose(
      FRAMINGS[view],
      camera.fov,
      (size.width - panel) / size.height
    )
    homePose.current = home
    const pose = focus ?? home
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
    // Any input anywhere in the app (moving toward another cluster, reading a
    // panel, typing) postpones auto-rotation.
    const options = { capture: true, passive: true }
    const inputs = ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const
    for (const type of inputs) window.addEventListener(type, mark, options)
    return () => {
      controls.removeEventListener('controlstart', mark)
      controls.removeEventListener('control', mark)
      for (const type of inputs) window.removeEventListener(type, mark, options)
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

    // Auto-rotate only when nothing has your attention: no hover, selection,
    // focused topic or camera focus, and the camera at its home framing.
    const now = performance.now()
    const speed = AUTO_ROTATE[view]
    const app = useApp.getState()
    if (
      !speed ||
      focus ||
      app.hovered ||
      app.selected ||
      app.focusCluster !== undefined ||
      isExamining(controls, homePose.current, position.current, target.current)
    )
      lastEngaged.current = now
    const quiet = now - Math.max(lastInteraction.current, lastEngaged.current)
    const spin = speed && quiet > IDLE_MS
    if (spin) {
      const ramp = Math.min(1, (quiet - IDLE_MS) / SPIN_UP_MS)
      controls.azimuthAngle += delta * speed * ramp * ramp * (3 - 2 * ramp)
    }
    if (spin !== spinning.current) {
      spinning.current = !!spin
      app.setAutoRotating(!!spin)
    }
  })

  useEffect(
    () => () => {
      if (spinning.current) useApp.getState().setAutoRotating(false)
    },
    []
  )

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

/** Zoomed in on, or panned over to, part of the scene. */
function isExamining(
  controls: CameraControlsImpl,
  home: Pose | undefined,
  position: THREE.Vector3,
  target: THREE.Vector3
) {
  if (!home) return false
  controls.getPosition(position)
  controls.getTarget(target)
  const homeDistance = Math.hypot(
    home.position[0] - home.target[0],
    home.position[1] - home.target[1],
    home.position[2] - home.target[2]
  )
  const offset = Math.hypot(
    target.x - home.target[0],
    target.y - home.target[1],
    target.z - home.target[2]
  )
  return (
    position.distanceTo(target) < homeDistance * ZOOMED_IN ||
    offset > homeDistance * PANNED_AWAY
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
