import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'

import type { Clock } from '../semantic/scheduler'

// Append-only, int8-quantized vector cache:
//   header: "MURE" magic, version, dim (u32 LE each)
//   records: 8-byte key, dim × int8 (largest component scaled to ±127)
// Later records win, so a run can append batch by batch (and resume after an
// interruption); the file is compacted when it accumulates stale records.

const MAGIC = 0x4d555245
const VERSION = 2
const HEADER = 12
const KEY_BYTES = 8

export function vectorKey(id: string, model: string, input: string): string {
  return createHash('sha1')
    .update(id)
    .update('\0')
    .update(model)
    .update('\0')
    .update(input)
    .digest('hex')
    .slice(0, KEY_BYTES * 2)
}

/** int8 with the largest component at ±127; rows are re-normalized on read. */
export function quantize(v: Float32Array): Int8Array {
  let max = 0
  for (const x of v) max = Math.max(max, Math.abs(x))
  const q = new Int8Array(v.length)
  if (max > 0)
    for (let i = 0; i < v.length; i++) q[i] = Math.round((v[i]! / max) * 127)
  return q
}

/** Writes the L2-normalized vector for `q` into `out` at `offset`. */
export function dequantizeInto(
  q: Int8Array,
  out: Float32Array,
  offset: number
): void {
  let norm = 0
  for (const v of q) norm += v * v
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0
  for (let t = 0; t < q.length; t++) out[offset + t] = q[t]! * inv
}

export class VectorCache {
  readonly entries = new Map<string, Int8Array>()
  private records = 0
  private writes = Promise.resolve()

  private constructor(
    readonly file: string,
    readonly dim: number
  ) {}

  /** Opens the cache, discarding it if missing, corrupt or of another dimension. */
  static async open(
    file: string,
    dim: number,
    clock?: Clock
  ): Promise<VectorCache> {
    const cache = new VectorCache(file, dim)
    if (!existsSync(file)) return cache
    try {
      const buf = await readFile(file)
      if (
        buf.length < HEADER ||
        buf.readUInt32LE(0) !== MAGIC ||
        buf.readUInt32LE(4) !== VERSION ||
        buf.readUInt32LE(8) !== dim
      )
        return cache
      const size = KEY_BYTES + dim
      const bytes = new Int8Array(buf.buffer, buf.byteOffset, buf.length)
      // A torn final record (interrupted append) is ignored.
      const count = Math.floor((buf.length - HEADER) / size)
      for (let r = 0; r < count; r++) {
        const off = HEADER + r * size
        cache.entries.set(
          buf.toString('hex', off, off + KEY_BYTES),
          bytes.slice(off + KEY_BYTES, off + size)
        )
        if ((r & 1023) === 0 && clock?.due()) await clock.pause()
      }
      cache.records = count
    } catch {
      cache.entries.clear()
    }
    return cache
  }

  private encode(items: Array<[string, Int8Array]>): Buffer {
    const size = KEY_BYTES + this.dim
    const buf = Buffer.alloc(items.length * size)
    items.forEach(([key, q], r) => {
      buf.write(key, r * size, KEY_BYTES, 'hex')
      buf.set(
        new Uint8Array(q.buffer, q.byteOffset, this.dim),
        r * size + KEY_BYTES
      )
    })
    return buf
  }

  private header(): Buffer {
    const buf = Buffer.alloc(HEADER)
    buf.writeUInt32LE(MAGIC, 0)
    buf.writeUInt32LE(VERSION, 4)
    buf.writeUInt32LE(this.dim, 8)
    return buf
  }

  /** Adds vectors and appends them to disk (writes are serialized). */
  append(items: Array<[string, Int8Array]>): Promise<void> {
    if (!items.length) return this.writes
    for (const [key, q] of items) this.entries.set(key, q)
    const chunk = this.encode(items)
    this.writes = this.writes.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      if (this.records === 0) await writeFile(this.file, this.header())
      await appendFile(this.file, chunk)
      this.records += items.length
    })
    return this.writes
  }

  /** Rewrites the file with only `keep` when stale records dominate. */
  async compact(keep: ReadonlySet<string>): Promise<void> {
    await this.writes
    const live = [...this.entries].filter(([key]) => keep.has(key))
    if (this.records <= live.length * 1.25 + 64) return
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, Buffer.concat([this.header(), this.encode(live)]))
    await rename(tmp, this.file)
    this.entries.clear()
    for (const [key, q] of live) this.entries.set(key, q)
    this.records = live.length
  }
}
