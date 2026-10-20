import { useMemo } from 'react'

import { searchTweets, type Model } from '../data/model'
import { useApp } from '../store'

export const VIS = { hidden: 0, dim: 0.14, normal: 1, highlight: 2 } as const

/**
 * Per-tweet visibility from the user's filters: kinds, time range, search,
 * and (in Growth) the focused inflection's likely causes.
 */
export function useTweetVisibility(model: Model) {
  const kinds = useApp((s) => s.kinds)
  const range = useApp((s) => s.range)
  const query = useApp((s) => s.query)
  const focusId = useApp((s) => s.focusInflection)
  const view = useApp((s) => s.view)
  const focusCluster = useApp((s) => s.focusCluster)

  const matches = useMemo(
    () => searchTweets(model, query.trim()),
    [model, query]
  )

  return useMemo(() => {
    const { n, kind, t } = model
    const vis = new Float32Array(n).fill(VIS.normal)
    const q = query.trim().length > 0
    if (q) vis.fill(VIS.dim)
    for (const i of matches) vis[i] = VIS.highlight
    for (let i = 0; i < n; i++) {
      if (!kinds[kind[i]!]) vis[i] = VIS.hidden
      else if (range && (t[i]! < range[0] || t[i]! > range[1]))
        // Strata hides other periods outright; elsewhere they stay as a ghost.
        vis[i] = q || view === 'strata' ? VIS.hidden : VIS.dim * 0.4
    }
    if (focusCluster !== undefined && !q) {
      for (let i = 0; i < n; i++) {
        if (vis[i]! < VIS.normal) continue
        vis[i] = model.cluster[i] === focusCluster ? VIS.highlight : VIS.dim
      }
    }
    const focus =
      view === 'growth' && focusId
        ? model.ds.inflections.find((f) => f.id === focusId)
        : undefined
    if (focus) {
      for (let i = 0; i < n; i++) if (vis[i] === VIS.normal) vis[i] = 0.32
      for (const c of focus.causes)
        if (c.tweet >= 0) vis[c.tweet] = VIS.highlight
    }
    const key = `${query}|${kinds.join()}|${range?.join() ?? ''}|${range ? view : ''}|${focus?.id ?? ''}|${focusCluster ?? ''}`
    return { vis, key, matches }
  }, [model, kinds, range, query, matches, focusId, view, focusCluster])
}

/** People visibility from the search box (handles and names). */
export function usePeopleVisibility(model: Model) {
  const query = useApp((s) => s.query)
  return useMemo(() => {
    const { people } = model.ds
    const vis = new Float32Array(people.n).fill(VIS.normal)
    const q = query.trim().toLowerCase().replace(/^@/, '')
    if (q) {
      for (let p = 0; p < people.n; p++) {
        const hit =
          people.handle[p]!.toLowerCase().includes(q) ||
          people.name[p]!.toLowerCase().includes(q)
        vis[p] = hit ? VIS.highlight : VIS.dim
      }
    }
    return { vis, key: q }
  }, [model, query])
}
