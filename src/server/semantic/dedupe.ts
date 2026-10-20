/**
 * Collapse rows with bit-identical vectors (identical texts after URL /
 * mention stripping, tombstones like "this post is unavailable") to one
 * representative. Clustering and layout then run on unique rows only:
 * cheaper, and duplicates no longer form disconnected kNN cliques that UMAP
 * flings to the far edge of the map.
 */
export function groupDuplicates(
  X: Float32Array,
  m: number,
  d: number
): { unique: Int32Array; groupOf: Int32Array } {
  const bits = new Uint32Array(X.buffer, X.byteOffset, m * d)
  const buckets = new Map<number, number[]>()
  const groupOf = new Int32Array(m)
  const unique: number[] = []
  const same = (a: number, b: number) => {
    for (let t = 0; t < d; t++)
      if (bits[a * d + t] !== bits[b * d + t]) return false
    return true
  }
  for (let i = 0; i < m; i++) {
    // FNV-1a over the float bits.
    let h = 0x811c9dc5
    for (let t = 0; t < d; t++) h = Math.imul(h ^ bits[i * d + t]!, 0x01000193)
    const bucket = buckets.get(h)
    const match = bucket?.find((g) => same(unique[g]!, i))
    if (match !== undefined) {
      groupOf[i] = match
      continue
    }
    groupOf[i] = unique.length
    if (bucket) bucket.push(unique.length)
    else buckets.set(h, [unique.length])
    unique.push(i)
  }
  return { unique: Int32Array.from(unique), groupOf }
}
