import { useEffect, useState } from 'react'

/** Phones, and windows too short for the full chrome (phones held sideways). */
export const COMPACT = '(max-width: 767px), (max-height: 500px)'

/** Whether a media query matches, kept current as the window changes. */
export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}
