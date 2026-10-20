import { useThree } from '@react-three/fiber'
import { useCallback, useMemo, useRef } from 'react'
import * as THREE from 'three'

import type { Model } from '../data/model'
import { anatomyStats } from '../layouts/anatomy'
import { bangersLayout, selectBangers } from '../layouts/bangers'
import {
  computeArrivals,
  hiddenPeopleLayout,
  orbitLayout
} from '../layouts/people'
import {
  anatomyLayout,
  constellationLayout,
  growthLayout,
  strataLayout,
  sunLayout
} from '../layouts/tweets'
import { useApp } from '../store'
import { CameraRig, leftPanelWidth } from './CameraRig'
import { Effects } from './Effects'
import {
  AnatomyOverlay,
  BangersOverlay,
  ConstellationOverlay,
  GrowthOverlay,
  OrbitOverlay,
  StrataOverlay
} from './overlays'
import { ParticleField, type FieldHandle } from './ParticleField'
import { Picker } from './Picker'
import { usePeopleVisibility, useTweetVisibility } from './visibility'

const DAY = 86_400
// `?nofx` disables post-processing (useful on weak GPUs and for debugging).
const NO_FX =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('nofx')

export function Scene({ model }: { model: Model }) {
  const view = useApp((s) => s.view)
  const anatomyGroup = useApp((s) => s.anatomyGroup)
  const bangerMode = useApp((s) => s.bangerMode)
  const range = useApp((s) => s.range)
  const playhead = useApp((s) => s.playhead)
  const hovered = useApp((s) => s.hovered)
  const selected = useApp((s) => s.selected)
  const focusId = useApp((s) => s.focusInflection)
  const setHovered = useApp((s) => s.setHovered)
  const setSelected = useApp((s) => s.setSelected)

  // Layouts are pure functions of the model, so cache each one.
  const constellation = useMemo(() => constellationLayout(model), [model])
  const strata = useMemo(() => strataLayout(model), [model])
  const growth = useMemo(() => growthLayout(model), [model])
  const sun = useMemo(() => sunLayout(model), [model])
  const stats = useMemo(
    () => anatomyStats(model, anatomyGroup, range),
    [model, anatomyGroup, range]
  )
  const anatomy = useMemo(() => anatomyLayout(model, stats), [model, stats])
  const bangers = useMemo(
    () => selectBangers(model, bangerMode, range),
    [model, bangerMode, range]
  )
  const bangersView = useMemo(
    () => bangersLayout(model, bangers),
    [model, bangers]
  )
  const peopleHidden = useMemo(() => hiddenPeopleLayout(model), [model])
  const arrivals = useMemo(() => computeArrivals(model), [model])
  const peopleOrbit = useMemo(
    () => orbitLayout(model, playhead, arrivals),
    [model, playhead, arrivals]
  )

  const tweetLayout =
    view === 'constellation'
      ? constellation
      : view === 'strata'
        ? strata.layout
        : view === 'growth'
          ? growth
          : view === 'bangers'
            ? bangersView
            : view === 'anatomy'
              ? anatomy
              : sun
  const peopleLayout = view === 'orbit' ? peopleOrbit : peopleHidden

  const tweetVis = useTweetVisibility(model)
  const peopleVis = usePeopleVisibility(model)

  const tweetField = useRef<FieldHandle | null>(null)
  const peopleField = useRef<FieldHandle | null>(null)
  const isOrbit = view === 'orbit'

  // The hovered particle's world position anchors zoom-to-cursor.
  const anchorFor = useCallback(() => {
    const h = useApp.getState().hovered
    if (!h) return undefined
    const f = h.type === 'tweet' ? tweetField.current : peopleField.current
    if (!f || !f.settled()) return undefined
    const i = h.index
    return new THREE.Vector3(
      f.position[i * 3]!,
      f.position[i * 3 + 1]!,
      f.position[i * 3 + 2]!
    )
  }, [])

  const onTweetHover = useCallback(
    (i: number) => setHovered(i >= 0 ? { type: 'tweet', index: i } : undefined),
    [setHovered]
  )
  const onPersonHover = useCallback(
    (i: number) =>
      setHovered(i >= 0 ? { type: 'person', index: i } : undefined),
    [setHovered]
  )
  const onTweetPick = useCallback(
    (i: number) =>
      setSelected(i >= 0 ? { type: 'tweet', index: i } : undefined),
    [setSelected]
  )
  const onPersonPick = useCallback(
    (i: number) =>
      setSelected(i >= 0 ? { type: 'person', index: i } : undefined),
    [setSelected]
  )

  const flyTarget = useApp((s) => s.flyTarget)
  const camera = useThree((s) => s.camera)
  const flyFocus = useMemo(() => {
    if (!flyTarget) return undefined
    const layout = flyTarget.type === 'tweet' ? tweetLayout : peopleLayout
    const i = flyTarget.index
    const p: [number, number, number] = [
      layout.position[i * 3]!,
      layout.position[i * 3 + 1]!,
      layout.position[i * 3 + 2]!
    ]
    // Keep the current viewing direction, just glide closer.
    const dir = camera.position
      .clone()
      .sub(new THREE.Vector3(...p))
      .normalize()
      .multiplyScalar(view === 'constellation' || view === 'orbit' ? 5.5 : 9)
    return {
      position: [p[0] + dir.x, p[1] + dir.y, p[2] + dir.z] as [
        number,
        number,
        number
      ],
      target: p
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTarget])

  const size = useThree((s) => s.size)
  const inflectionFocus = useMemo(() => {
    if (view !== 'growth' || !focusId) return undefined
    const inf = model.ds.inflections.find((f) => f.id === focusId)
    if (!inf) return undefined
    // Frame the event window (plus the lead-up where causes live) across
    // both planes, seen slightly from the side so the arcs read in depth.
    const x0 = model.timeToX(inf.t0 - 21 * DAY)
    const x1 = model.timeToX(inf.t1)
    const cx = (x0 + x1) / 2
    const width = Math.max(6.5, x1 - x0 + 3)
    const aspect = (size.width - leftPanelWidth(size.width)) / size.height
    const tan = Math.tan((40 * Math.PI) / 360)
    const dist = Math.max(width / 2 / (tan * aspect), 10.5 / 2 / tan)
    const dir = new THREE.Vector3(0.28, 0.1, 1).normalize().multiplyScalar(dist)
    const target: [number, number, number] = [cx, 4.7, 0]
    return {
      position: [cx + dir.x, 4.7 + dir.y, dir.z] as [number, number, number],
      target
    }
  }, [view, focusId, model, size.width, size.height])
  // A time-range filter in Strata or Bangers frames that stretch of time.
  const rangeFocus = useMemo(() => {
    if (!range || (view !== 'strata' && view !== 'bangers')) return undefined
    const x0 = model.timeToX(Math.max(range[0], model.domain[0]))
    const x1 = model.timeToX(Math.min(range[1], model.domain[1]))
    const cx = (x0 + x1) / 2
    const width = Math.max(
      view === 'strata' ? 14 : 8,
      x1 - x0 + (view === 'strata' ? 8 : 3)
    )
    const height = view === 'strata' ? 15 : 11.6
    const ty = view === 'strata' ? 2.4 : 4.7
    const aspect = (size.width - leftPanelWidth(size.width)) / size.height
    const tan = Math.tan((40 * Math.PI) / 360)
    const dist = Math.max(width / 2 / (tan * aspect), height / 2 / tan) * 1.04
    const dir = new THREE.Vector3(
      ...((view === 'strata' ? [-0.05, 0.16, 1] : [0, 0.08, 1]) as [
        number,
        number,
        number
      ])
    )
      .normalize()
      .multiplyScalar(dist)
    return {
      position: [cx + dir.x, ty + dir.y, dir.z] as [number, number, number],
      target: [cx, ty, 0] as [number, number, number]
    }
  }, [range, view, model, size.width, size.height])

  const focus = flyFocus ?? inflectionFocus ?? rangeFocus

  return (
    <>
      <color attach='background' args={['#030406']} />
      <fog attach='fog' args={['#030406', 26, 62]} />
      <CameraRig focus={focus} anchorFor={anchorFor} />

      <ParticleField
        count={model.n}
        layout={tweetLayout}
        vis={tweetVis.vis}
        visKey={tweetVis.key}
        hover={hovered?.type === 'tweet' ? hovered.index : -1}
        selected={selected?.type === 'tweet' ? selected.index : -1}
        handle={tweetField}
        gain={1}
      />
      <ParticleField
        count={model.ds.people.n}
        layout={peopleLayout}
        vis={peopleVis.vis}
        visKey={peopleVis.key}
        hover={hovered?.type === 'person' ? hovered.index : -1}
        selected={selected?.type === 'person' ? selected.index : -1}
        handle={peopleField}
        minPx={1.3}
      />

      <Picker
        field={tweetField}
        enabled={!isOrbit}
        onHover={onTweetHover}
        onPick={onTweetPick}
      />
      <Picker
        field={peopleField}
        enabled={isOrbit}
        onHover={onPersonHover}
        onPick={onPersonPick}
      />

      {view === 'constellation' && <ConstellationOverlay model={model} />}
      {view === 'strata' && (
        <StrataOverlay model={model} geometry={strata.geometry} />
      )}
      {view === 'growth' && <GrowthOverlay model={model} />}
      {view === 'bangers' && <BangersOverlay model={model} bangers={bangers} />}
      {view === 'anatomy' && <AnatomyOverlay model={model} stats={stats} />}
      {view === 'orbit' && <OrbitOverlay model={model} />}

      {!NO_FX && <Effects />}
    </>
  )
}
