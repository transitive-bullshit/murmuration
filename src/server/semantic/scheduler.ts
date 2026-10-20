/**
 * Cooperative scheduling for long CPU loops: call `due()` cheaply inside a
 * loop and `await pause()` only when it returns true, so the host event loop
 * (e.g. a dev server answering progress requests) is never blocked for long.
 */
export interface Clock {
  due(): boolean
  pause(): Promise<void>
}

export function createClock(budgetMs = 30): Clock {
  let last = performance.now()
  return {
    due: () => performance.now() - last >= budgetMs,
    pause: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      last = performance.now()
    }
  }
}
