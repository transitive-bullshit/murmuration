/** A loaded embedding backend. Vectors are L2-normalized, row-major n × dim. */
export interface Embedder {
  /** most inputs per request when the longest input has this many characters */
  maxBatch(longestChars: number): number
  /** requests in flight at once */
  readonly concurrency: number
  embed(
    texts: string[],
    signal?: AbortSignal
  ): Promise<{ data: Float32Array; dim: number }>
  close?(): Promise<void> | void
}

/** Names a backend and loads it only when something actually needs embedding. */
export interface EmbedderSpec {
  provider: 'openai' | 'local' | (string & {})
  /** model id; part of every cache key */
  model: string
  dim: number
  /** requests cost money: they're planned, capped and need the build lock */
  paid?: boolean
  load(): Promise<Embedder>
}
