import { create } from 'zustand'

import type { Model } from './data/model'
import { viewFromPath, type ViewId } from './views'

export { VIEWS, viewFromPath, type ViewId } from './views'

export type BangerMode = 'engagement' | 'outlier'

export type AnatomyGroup = 'format' | 'topic' | 'weekday' | 'hour' | 'length'
export type Target = { type: 'tweet' | 'person'; index: number }

export interface AppState {
  model: Model | undefined
  view: ViewId
  query: string
  kinds: [boolean, boolean, boolean]
  /** inclusive unix-seconds range filter, or undefined for everything */
  range: [number, number] | undefined
  /** current time for the Orbit view's time travel; undefined = now */
  playhead: number | undefined
  playing: boolean
  hovered: Target | undefined
  selected: Target | undefined
  anatomyGroup: AnatomyGroup
  bangerMode: BangerMode
  focusInflection: string | undefined
  /** semantic cluster to spotlight */
  focusCluster: number | undefined
  mediaPreviews: boolean
  /** bumps when the camera should glide back to the view's home pose */
  cameraHome: number
  /** the idle camera is slowly turning on its own */
  autoRotating: boolean
  /** a selection the camera should fly to (from lists, not scene clicks) */
  flyTarget: (Target & { nonce: number }) | undefined

  setModel: (model: Model) => void
  setView: (view: ViewId) => void
  setQuery: (query: string) => void
  toggleKind: (kind: 0 | 1 | 2) => void
  setRange: (range: [number, number] | undefined) => void
  setPlayhead: (t: number | undefined) => void
  setPlaying: (playing: boolean) => void
  setHovered: (target: Target | undefined) => void
  setSelected: (target: Target | undefined) => void
  /** select and glide the camera to it */
  flyTo: (target: Target) => void
  setAnatomyGroup: (group: AnatomyGroup) => void
  setBangerMode: (mode: BangerMode) => void
  setFocusInflection: (id: string | undefined) => void
  setFocusCluster: (id: number | undefined) => void
  setMediaPreviews: (on: boolean) => void
  setAutoRotating: (on: boolean) => void
  goHome: () => void
}

const readPref = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(`murmuration:${key}`)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
const writePref = (key: string, value: unknown) => {
  try {
    localStorage.setItem(`murmuration:${key}`, JSON.stringify(value))
  } catch {}
}

// A view's own URL wins over the one remembered from last time, and becomes
// the remembered one, so a later visit to / comes back to it.
const urlView =
  typeof location === 'undefined'
    ? undefined
    : viewFromPath(location.pathname, import.meta.env.BASE_URL)
if (urlView) writePref('view', urlView)

export const useApp = create<AppState>((set) => ({
  model: undefined,
  view: urlView ?? readPref<ViewId>('view', 'constellation'),
  query: '',
  kinds: [true, true, true],
  range: undefined,
  playhead: undefined,
  playing: false,
  hovered: undefined,
  selected: undefined,
  anatomyGroup: readPref<AnatomyGroup>('anatomyGroup', 'format'),
  bangerMode: readPref<BangerMode>('bangerMode', 'engagement'),
  focusInflection: undefined,
  focusCluster: undefined,
  mediaPreviews: readPref('mediaPreviews', true),
  cameraHome: 0,
  autoRotating: false,
  flyTarget: undefined,

  setModel: (model) => set({ model }),
  setView: (view) => {
    writePref('view', view)
    set({
      view,
      hovered: undefined,
      focusInflection: undefined,
      playing: false,
      flyTarget: undefined
    })
  },
  setQuery: (query) => set({ query }),
  toggleKind: (kind) =>
    set((s) => {
      const kinds = [...s.kinds] as [boolean, boolean, boolean]
      kinds[kind] = !kinds[kind]
      return { kinds }
    }),
  setRange: (range) => set({ range }),
  setPlayhead: (playhead) => set({ playhead }),
  setPlaying: (playing) => set({ playing }),
  setHovered: (hovered) =>
    set((s) =>
      s.hovered?.type === hovered?.type && s.hovered?.index === hovered?.index
        ? s
        : { hovered }
    ),
  setSelected: (selected) =>
    set(selected ? { selected } : { selected, flyTarget: undefined }),
  flyTo: (target) =>
    set((s) => ({
      selected: target,
      flyTarget: { ...target, nonce: (s.flyTarget?.nonce ?? 0) + 1 }
    })),
  setAnatomyGroup: (anatomyGroup) => {
    writePref('anatomyGroup', anatomyGroup)
    set({ anatomyGroup })
  },
  setBangerMode: (bangerMode) => {
    writePref('bangerMode', bangerMode)
    set({ bangerMode })
  },
  setFocusInflection: (focusInflection) => set({ focusInflection }),
  setFocusCluster: (focusCluster) => set({ focusCluster }),
  setAutoRotating: (autoRotating) => set({ autoRotating }),
  setMediaPreviews: (mediaPreviews) => {
    writePref('mediaPreviews', mediaPreviews)
    set({ mediaPreviews })
  },
  goHome: () =>
    set((s) => ({
      cameraHome: s.cameraHome + 1,
      focusInflection: undefined,
      flyTarget: undefined
    }))
}))
