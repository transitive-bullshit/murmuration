import type { BuildProgress, Dataset } from '../../shared/types'

export interface Status extends BuildProgress {
  ready: boolean
  stale: boolean
  generatedAt?: string
  /** dev only: serving data/dataset.json, or a live build from the archive */
  source?: 'export' | 'archive'
}

export async function fetchStatus(): Promise<Status> {
  const res = await fetch('/api/status')
  if (!res.ok) throw new Error(`Status request failed (${res.status})`)
  return (await res.json()) as Status
}

/**
 * Production builds are static: the exported dataset ships next to the app.
 * In dev, the local server serves the export or builds from your archive.
 */
export function loadDataset(
  onProgress: (status: Status) => void
): Promise<Dataset> {
  return import.meta.env.PROD
    ? loadExport(onProgress)
    : loadFromServer(onProgress)
}

async function loadFromServer(
  onProgress: (status: Status) => void
): Promise<Dataset> {
  for (;;) {
    const status = await fetchStatus()
    onProgress(status)
    if (status.ready) break
    if (status.error) throw new Error(status.error)
    await new Promise((r) => setTimeout(r, 220))
  }
  const res = await fetch('/api/dataset')
  if (!res.ok) throw new Error(`Dataset request failed (${res.status})`)
  return (await res.json()) as Dataset
}

async function loadExport(
  onProgress: (status: Status) => void
): Promise<Dataset> {
  const report = (fraction: number) =>
    onProgress({
      phase: 'Loading your archive',
      fraction,
      done: false,
      ready: false,
      stale: false
    })
  report(0)
  // Preloaded from index.html, so the download overlaps the app's own.
  const res = await fetch(`${import.meta.env.BASE_URL}data/dataset.json`)
  if (!res.ok) throw new Error(`Dataset request failed (${res.status})`)
  // The CDN compresses the file, so Content-Length isn't the decoded size;
  // the build records that instead.
  const expected = import.meta.env.MURMURATION_DATASET_BYTES ?? 0
  if (!res.body || !expected) return (await res.json()) as Dataset
  const reader = res.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    report(Math.min(1, loaded / expected))
  }
  return (await new Response(new Blob(chunks)).json()) as Dataset
}

export async function requestRebuild(): Promise<void> {
  await fetch('/api/rebuild', { method: 'POST' })
}
