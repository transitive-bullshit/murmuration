// Small color helpers. Particle colors live in linear sRGB so they blend and
// bloom correctly; UI colors stay as sRGB hex strings.

export type RGB = [number, number, number]

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055

export function hexToLinear(hex: string): RGB {
  const v = Number.parseInt(hex.replace('#', ''), 16)
  return [
    srgbToLinear(((v >> 16) & 255) / 255),
    srgbToLinear(((v >> 8) & 255) / 255),
    srgbToLinear((v & 255) / 255)
  ]
}

export function linearToHex([r, g, b]: RGB): string {
  const to = (c: number) =>
    Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** OKLCH (L 0..1, C, h degrees) → linear sRGB, gamut-clipped by chroma reduction. */
export function oklchToLinear(l: number, c: number, h: number): RGB {
  for (let chroma = c; chroma >= 0; chroma -= 0.01) {
    const rgb = oklabToLinear(
      l,
      chroma * Math.cos((h * Math.PI) / 180),
      chroma * Math.sin((h * Math.PI) / 180)
    )
    if (rgb.every((v) => v >= -1e-4 && v <= 1.0001))
      return rgb.map((v) => Math.min(1, Math.max(0, v))) as RGB
  }
  return oklabToLinear(l, 0, 0)
}

function oklabToLinear(L: number, a: number, b: number): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

export const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
]

export const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k]

// Fixed categorical order (dark-surface steps of the validated palette).
export const SERIES = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767'
]

// Kinds and relationship types use the first three slots, which are the only
// ones validated all-pairs (they appear together in scatter-like views).
export const KIND_HEX = {
  mine: '#d95926',
  like: '#3987e5',
  bookmark: '#199e70'
} as const

export const FORMAT_HEX: Record<string, string> = {
  text: '#3987e5',
  image: '#d95926',
  video: '#199e70',
  link: '#c98500',
  quote: '#d55181',
  thread: '#008300',
  reply: '#9085e9',
  retweet: '#e66767'
}

export const REL_HEX = {
  follower: '#3987e5',
  following: '#d95926',
  mutual: '#199e70'
} as const
