import { useEffect } from 'react'

import { useApp, viewFromPath, type ViewId } from '../store'

/**
 * Gives each view its own URL (/constellation, /strata, …): the address bar
 * follows the current view, so links and reloads land on it, and Back and
 * Forward move between views.
 */
export function useViewUrl() {
  useEffect(() => {
    const base = import.meta.env.BASE_URL
    const pathFor = (view: ViewId) => `${base}${view}`
    const go = (view: ViewId, push: boolean) => {
      if (location.pathname === pathFor(view)) return
      const url = `${pathFor(view)}${location.search}${location.hash}`
      if (push) history.pushState(null, '', url)
      else history.replaceState(history.state, '', url)
    }
    // Show the starting view's URL (e.g. the one remembered from last time)
    // without adding a history entry.
    go(useApp.getState().view, false)
    const unsubscribe = useApp.subscribe((state, prev) => {
      if (state.view !== prev.view) go(state.view, true)
    })
    const onPopState = () => {
      const view = viewFromPath(location.pathname, base)
      if (view && view !== useApp.getState().view)
        useApp.getState().setView(view)
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      unsubscribe()
      window.removeEventListener('popstate', onPopState)
    }
  }, [])
}
