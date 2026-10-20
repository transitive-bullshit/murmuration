// Worker thread for local sentence embeddings (see local.ts). onnxruntime-node
// runs inference synchronously on the calling thread, which would stall the
// dev server for hundreds of milliseconds per batch. Node loads this file
// directly (type stripping), so: erasable TypeScript only, no relative imports.
import { parentPort, workerData } from 'node:worker_threads'

import { env, pipeline } from '@huggingface/transformers'

interface Init {
  model: string
  cacheDir: string
  pooling: 'mean' | 'cls'
}

interface Request {
  id: number
  texts: string[]
}

const port = parentPort
if (!port) throw new Error('embed-worker must run in a worker thread')

const { model, cacheDir, pooling } = workerData as Init
env.cacheDir = cacheDir
// Weights are fetched from the Hugging Face Hub once, then read from cacheDir.
const extractor = await pipeline('feature-extraction', model, {
  dtype: 'q8',
  device: 'cpu'
})
port.postMessage({ type: 'ready' })

port.on('message', async ({ id, texts }: Request) => {
  try {
    const output = await extractor(texts, { pooling, normalize: true })
    const data = Float32Array.from(output.data as Float32Array)
    port.postMessage({ type: 'result', id, dim: output.dims[1], data }, [
      data.buffer
    ])
  } catch (err) {
    port.postMessage({
      type: 'error',
      id,
      message: err instanceof Error ? err.message : String(err)
    })
  }
})
