import type { Layout } from '../gl/ParticleField'

export function emptyLayout(n: number, key: string): Layout {
  return {
    key,
    position: new Float32Array(n * 3),
    color: new Float32Array(n * 3),
    size: new Float32Array(n),
    alpha: new Float32Array(n),
    delay: new Float32Array(n),
    glyph: 0
  }
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Vertical scale shared by every engagement plot (Growth and Anatomy). */
export const ENG_HEIGHT = 4.2

export const engY = (logEng: number, maxLogEng: number) =>
  (logEng / maxLogEng) * ENG_HEIGHT

/** Followers plane sits above the engagement plane on the same time axis. */
export const FOLLOWERS_BASE = 5.4
export const FOLLOWERS_HEIGHT = 4.2

export function setRgb(
  out: Float32Array,
  i: number,
  rgb: readonly number[],
  k = 1
) {
  out[i * 3] = rgb[0]! * k
  out[i * 3 + 1] = rgb[1]! * k
  out[i * 3 + 2] = rgb[2]! * k
}

export function setXyz(
  out: Float32Array,
  i: number,
  x: number,
  y: number,
  z: number
) {
  out[i * 3] = x
  out[i * 3 + 1] = y
  out[i * 3 + 2] = z
}

/** Nice round ticks for a log10 engagement axis. */
export function logTicks(maxLogEng: number): number[] {
  const ticks: number[] = []
  for (let p = 0; p <= Math.floor(maxLogEng); p++) ticks.push(10 ** p)
  return ticks
}
