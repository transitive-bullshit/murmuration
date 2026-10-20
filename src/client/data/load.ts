import type { BuildProgress, Dataset } from '../../shared/types'

export interface Status extends BuildProgress {
  ready: boolean
  stale: boolean
  generatedAt?: string
}

export async function fetchStatus(): Promise<Status> {
  const res = await fetch('/api/status')
  if (!res.ok) throw new Error(`Status request failed (${res.status})`)
  return (await res.json()) as Status
}

/** Polls the local build until it's ready, then downloads the dataset. */
export async function loadDataset(
  onProgress: (status: Status) => void
): Promise<Dataset> {
  for (;;) {
    const status = await fetchStatus()
    onProgress(status)
    if (status.error) throw new Error(status.error)
    if (status.ready) break
    await new Promise((r) => setTimeout(r, 220))
  }
  const res = await fetch('/api/dataset')
  if (!res.ok) throw new Error(`Dataset request failed (${res.status})`)
  return (await res.json()) as Dataset
}

export async function requestRebuild(): Promise<void> {
  await fetch('/api/rebuild', { method: 'POST' })
}
