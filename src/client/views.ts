// The six views and their URLs. Kept free of browser globals so Node scripts
// (scripts/smoke.ts, scripts/shots.ts) can import it.

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
    id: 'bangers',
    label: 'Bangers',
    hint: 'Your biggest hits and outliers over time'
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

/** The view a URL path names (/strata, /orbit, …), if any. */
export function viewFromPath(pathname: string, base = '/'): ViewId | undefined {
  const rest = pathname.startsWith(base)
    ? pathname.slice(base.length)
    : pathname.replace(/^\//, '')
  const segment = rest.replace(/\/+$/, '')
  return VIEWS.find((v) => v.id === segment)?.id
}
