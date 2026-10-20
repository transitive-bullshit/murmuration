import { useEffect, useRef } from 'react'

import { VIEWS, useApp } from '../store'

let searchInput: HTMLInputElement | null = null

/** Registers the search box so `/` and ⌘K can focus it. */
export function useSearchInput() {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    searchInput = ref.current
    return () => {
      searchInput = null
    }
  }, [])
  return ref
}

export function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      const s = useApp.getState()
      if (
        (e.key === 'k' && (e.metaKey || e.ctrlKey)) ||
        (e.key === '/' && !typing)
      ) {
        e.preventDefault()
        searchInput?.focus()
        searchInput?.select()
        return
      }
      if (typing) return
      if (e.key === 'Escape') {
        if (s.selected) s.setSelected(undefined)
        else if (s.focusInflection) s.setFocusInflection(undefined)
        else if (s.focusCluster !== undefined) s.setFocusCluster(undefined)
        else if (s.query) s.setQuery('')
        else if (s.range) s.setRange(undefined)
        return
      }
      const n = Number(e.key)
      if (
        n >= 1 &&
        n <= VIEWS.length &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        s.setView(VIEWS[n - 1]!.id)
        return
      }
      if (e.key === 'h') s.goHome()
      if (e.key === ' ' && s.view === 'orbit') {
        e.preventDefault()
        s.setPlaying(!s.playing)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
