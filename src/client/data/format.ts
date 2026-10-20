const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1
})
const full = new Intl.NumberFormat('en-US')

export const fmtCompact = (n: number) =>
  n < 0 ? '—' : n < 1000 ? full.format(Math.round(n)) : compact.format(n)
export const fmtInt = (n: number) => (n < 0 ? '—' : full.format(Math.round(n)))

export const fmtMultiple = (n: number) =>
  n >= 100
    ? `${full.format(Math.round(n))}×`
    : n >= 10
      ? `${Math.round(n)}×`
      : `${n.toFixed(1)}×`

const monthYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric'
})
const dayMonthYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})
const dayMonth = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric'
})

export const fmtMonth = (t: number) => monthYear.format(t * 1000)
export const fmtDate = (t: number) => dayMonthYear.format(t * 1000)
export const fmtDayMonth = (t: number) => dayMonth.format(t * 1000)

export function fmtRange(t0: number, t1: number) {
  const a = new Date(t0 * 1000)
  const b = new Date(t1 * 1000)
  if (a.getFullYear() === b.getFullYear())
    return `${fmtDayMonth(t0)} – ${fmtDate(t1)}`
  return `${fmtDate(t0)} – ${fmtDate(t1)}`
}

export function decodeEntities(text: string) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** Tweet text for display: entities decoded, trailing t.co media links dropped. */
export function displayText(text: string) {
  return decodeEntities(text)
    .replace(/\s*\{learnmore\}/g, '')
    .replace(/(\s*https:\/\/t\.co\/\w+)+\s*$/, '')
    .trim()
}

export const tweetUrl = (id: string) => `https://x.com/i/status/${id}`
export const profileUrl = (handle: string) => `https://x.com/${handle}`
