import { create } from 'zustand'

import type { Model } from './data/model'

export const VIEWS = [
  {
    id: 'constellation',
    label: 'Constellation',
    hint: 'Every tweet and like, arranged by meaning'
  },
  {
    id: 'strata',
    label: 'Strata',
    hint: 'Your timeline, stacked month by month'
  },
  {
    id: 'growth',
    label: 'Growth',
    hint: 'Followers and engagement over time, with inflection points'
  },
  {
    id: 'anatomy',
    label: 'Anatomy',
    hint: 'Which kinds of tweets perform best, and how that changed'
  },
  {
    id: 'orbit',
    label: 'Orbit',
    hint: 'Followers, following, and your closest relationships'
  }
] as const

export type ViewId = (typeof VIEWS)[number]['id']

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
  focusInflection: string | undefined
  /** semantic cluster to spotlight */
  focusCluster: number | undefined
  mediaPreviews: boolean
  /** bumps when the camera should glide back to the view's home pose */
  cameraHome: number
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
  setFocusInflection: (id: string | undefined) => void
  setFocusCluster: (id: number | undefined) => void
  setMediaPreviews: (on: boolean) => void
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

export const useApp = create<AppState>((set) => ({
  model: undefined,
  view: readPref<ViewId>('view', 'constellation'),
  query: '',
  kinds: [true, true, true],
  range: undefined,
  playhead: undefined,
  playing: false,
  hovered: undefined,
  selected: undefined,
  anatomyGroup: readPref<AnatomyGroup>('anatomyGroup', 'format'),
  focusInflection: undefined,
  focusCluster: undefined,
  mediaPreviews: readPref('mediaPreviews', true),
  cameraHome: 0,
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
  setFocusInflection: (focusInflection) => set({ focusInflection }),
  setFocusCluster: (focusCluster) => set({ focusCluster }),
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
