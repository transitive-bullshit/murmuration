/** Small seeded PRNG (mulberry32): fast, deterministic, good enough for sampling. */
export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Derive an independent stream for a sub-task so phases don't share state. */
export function deriveRng(seed: number, stream: number): Rng {
  return mulberry32(
    Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(stream + 1, 0xc2b2ae35)
  )
}

export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n)
}

/** Standard normal via Box-Muller. */
export function gaussian(rng: Rng): number {
  let u = 0
  while (u === 0) u = rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
