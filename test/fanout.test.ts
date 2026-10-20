import { describe, expect, it } from 'vitest'

import { FanoutAbortedError, fanout } from '../src/server/fanout'

const items = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('fanout error budget', () => {
  it('skips scattered failures and keeps going', async () => {
    const lines: string[] = []
    const failedItems: number[] = []
    const { results, failed, warning } = await fanout(
      items(200),
      async (i) => {
        if (i === 10 || i === 150) throw new Error(`boom ${i}`)
        return i * 2
      },
      {
        label: 'things',
        log: (l) => lines.push(l),
        onFailure: (i) => failedItems.push(i)
      }
    )
    expect(failed).toBe(2)
    expect(results[10]).toBeUndefined()
    expect(results[11]).toBe(22)
    expect(results.filter((r) => r !== undefined)).toHaveLength(198)
    expect(failedItems.sort((a, b) => a - b)).toEqual([10, 150])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('things: skipped #10: boom 10')
    expect(warning).toBeUndefined()
  })

  it('warns when failures pass the soft threshold', async () => {
    const { failed, warning } = await fanout(
      items(100),
      async (i) => {
        if (i % 20 === 7) throw new Error('nope')
        return i
      },
      { label: 'image captions', log: () => {} }
    )
    expect(failed).toBe(5)
    expect(warning).toBe(
      "5 of 100 image captions failed; they'll be retried on the next rebuild."
    )
  })

  it('stops after a streak of consecutive failures', async () => {
    let calls = 0
    const run = fanout(
      items(200),
      async (i) => {
        calls++
        if (i >= 30) throw new Error('service down')
        return i
      },
      { label: 'things', concurrency: 1, log: () => {} }
    )
    await expect(run).rejects.toThrow(/10 failures in a row/)
    await expect(run).rejects.toBeInstanceOf(FanoutAbortedError)
    expect(calls).toBe(40)
  })

  it('stops when the failure rate passes the ceiling', async () => {
    const run = fanout(
      items(500),
      async (i) => {
        if (i % 3 !== 0) throw new Error('flaky')
        return i
      },
      { label: 'things', concurrency: 1, log: () => {} }
    )
    const error = await run.catch((err: unknown) => err)
    expect(error).toBeInstanceOf(FanoutAbortedError)
    expect((error as FanoutAbortedError).progress.done).toBe(40)
  })

  it('stops immediately on a fatal error without blaming the item', async () => {
    let calls = 0
    const failedItems: number[] = []
    const error = await fanout(
      items(100),
      async (i) => {
        calls++
        if (i === 3) throw new Error('401 Unauthorized')
        return i
      },
      {
        label: 'things',
        concurrency: 1,
        classify: (e) => (String(e).includes('401') ? 'fatal' : 'item'),
        onFailure: (i) => failedItems.push(i),
        log: () => {}
      }
    ).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(FanoutAbortedError)
    expect(String(error)).toContain('401 Unauthorized')
    expect(calls).toBe(4)
    expect(failedItems).toEqual([])
  })

  it('passes an abort signal to in-flight work and honors external cancellation', async () => {
    const controller = new AbortController()
    let sawAbort = false
    const run = fanout(
      items(50),
      async (i, { signal }) => {
        if (i === 5) controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 5))
        sawAbort ||= signal.aborted
        return i
      },
      { label: 'things', concurrency: 4, signal: controller.signal }
    )
    await expect(run).rejects.toThrow(/cancelled/)
    // In-flight work keeps running briefly but sees the aborted signal.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sawAbort).toBe(true)
  })
})
