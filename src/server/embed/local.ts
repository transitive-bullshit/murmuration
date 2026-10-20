import path from 'node:path'
import { Worker } from 'node:worker_threads'

import type { Embedder, EmbedderSpec } from './types'

// Local sentence embeddings with transformers.js (ONNX, int8). Inference runs
// in a worker thread because onnxruntime-node executes synchronously on its
// calling thread.

const MODELS: Record<string, { dim: number; pooling: 'mean' | 'cls' }> = {
  'Xenova/all-MiniLM-L6-v2': { dim: 384, pooling: 'mean' },
  'Xenova/bge-small-en-v1.5': { dim: 384, pooling: 'cls' }
}
export const DEFAULT_LOCAL_MODEL = 'Xenova/bge-small-en-v1.5'

interface Pending {
  resolve: (result: { data: Float32Array; dim: number }) => void
  reject: (err: Error) => void
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; dim: number; data: Float32Array }
  | { type: 'error'; id: number; message: string }

/** Weights are downloaded from the Hugging Face Hub once into `<cacheDir>/models`. */
export function localEmbedder(
  cacheDir: string,
  model = DEFAULT_LOCAL_MODEL
): EmbedderSpec {
  const info = MODELS[model]
  if (!info) throw new Error(`Unknown local embedding model: ${model}`)
  return {
    provider: 'local',
    model,
    dim: info.dim,
    load: () => startWorker(model, path.join(cacheDir, 'models'), info.pooling)
  }
}

async function startWorker(
  model: string,
  modelsDir: string,
  pooling: 'mean' | 'cls'
): Promise<Embedder> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    workerData: { model, cacheDir: modelsDir, pooling }
  })
  const pending = new Map<number, Pending>()
  let nextId = 0
  let failure: Error | undefined
  let started: { resolve: () => void; reject: (err: Error) => void } | undefined
  const ready = new Promise<void>(
    (resolve, reject) => (started = { resolve, reject })
  )
  const fail = (err: Error) => {
    failure ??= err
    started?.reject(err)
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }
  // One set of listeners for the worker's whole life: removing listeners
  // wholesale would also drop Node's internal hooks that keep the port open.
  worker.on('error', fail)
  worker.on('exit', (code) =>
    fail(new Error(`embedding worker exited (${code})`))
  )
  worker.on('message', (msg: WorkerMessage) => {
    if (msg.type === 'ready') return started?.resolve()
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.type === 'result') p.resolve({ data: msg.data, dim: msg.dim })
    else p.reject(new Error(msg.message))
  })
  await ready

  return {
    // Attention memory grows with batch × tokens²: up to 64 tweets per batch,
    // fewer as inputs get longer (~4 characters per token).
    maxBatch: (chars) =>
      Math.max(
        4,
        Math.min(64, Math.floor(16_000_000 / Math.max(chars, 1) ** 2))
      ),
    concurrency: 1,
    embed: (texts) =>
      new Promise((resolve, reject) => {
        if (failure) return reject(failure)
        const id = nextId++
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, texts })
      }),
    close: async () => {
      failure ??= new Error('embedding worker closed')
      await worker.terminate()
    }
  }
}
