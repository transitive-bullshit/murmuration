import { Canvas } from '@react-three/fiber'
import { useEffect, useState } from 'react'

import { loadDataset, type Status } from './data/load'
import { buildModel } from './data/model'
import { Scene } from './gl/Scene'
import { useApp } from './store'
import { DetailPanel } from './ui/DetailPanel'
import { HoverCard } from './ui/HoverCard'
import { Loading } from './ui/Loading'
import { Timeline } from './ui/Timeline'
import { TopBar } from './ui/TopBar'
import { ViewPanel } from './ui/ViewPanel'
import { useKeyboard } from './ui/useKeyboard'

export function App() {
  const model = useApp((s) => s.model)
  const setModel = useApp((s) => s.setModel)
  const [status, setStatus] = useState<Status | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadDataset((s) => !cancelled && setStatus(s))
      .then((ds) => {
        if (cancelled) return
        const t0 = performance.now()
        const m = buildModel(ds)
        console.info(
          `[murmuration] model built in ${Math.round(performance.now() - t0)}ms`,
          ds.meta
        )
        setModel(m)
        setTimeout(() => !cancelled && setRevealed(true), 60)
      })
      .catch(
        (err: unknown) =>
          !cancelled &&
          setError(err instanceof Error ? err.message : String(err))
      )
    return () => {
      cancelled = true
    }
  }, [setModel])

  useKeyboard()

  return (
    <div className='relative h-full w-full select-none'>
      {model && (
        <Canvas
          className='!absolute inset-0'
          dpr={[1, 2]}
          gl={{
            antialias: false,
            powerPreference: 'high-performance',
            alpha: false,
            stencil: false
          }}
          camera={{ fov: 40, near: 0.1, far: 200, position: [0, 6, 42] }}
          onCreated={(state) => {
            if (import.meta.env.DEV)
              Object.assign(window, { __r3f: state, __app: useApp })
          }}
        >
          <Scene model={model} />
        </Canvas>
      )}

      {model && (
        <div
          className={`pointer-events-none absolute inset-0 transition-opacity duration-1000 ${revealed ? 'opacity-100' : 'opacity-0'}`}
        >
          <TopBar model={model} />
          <ViewPanel model={model} />
          <Timeline model={model} />
          <DetailPanel model={model} />
          <HoverCard model={model} />
        </div>
      )}

      <Loading status={status} error={error} done={!!model} />
    </div>
  )
}
