import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  captionTweetImages,
  type CaptionerSpec,
  type Embedder,
  type EmbedderSpec
} from '../src/server/embed'
import { lockFile, withBuildLock } from '../src/server/lock'
import {
  DEFAULT_CAPS,
  SpendHeldError,
  captionAndEmbed,
  pauseFile,
  planPaidWork,
  spendCaps,
  stillHeld,
  type PaidInput,
  type PaidOptions,
  type PaidProviders
} from '../src/server/paid'

const DIM = 4

/** A fake paid captioner and embedder that record every request. */
function fakeOpenAI(
  options: {
    onCaption?: (urls: string[], signal?: AbortSignal) => Promise<void>
  } = {}
) {
  const captioned: string[] = []
  const embedded: string[] = []
  let loads = 0
  const caption = async (urls: string[], signal?: AbortSignal) => {
    await options.onCaption?.(urls, signal)
    captioned.push(...urls)
    return urls.map((url) => `a photo of ${url.slice(-5)}`)
  }
  const captioner: CaptionerSpec = {
    model: 'fake-vision',
    captioner: async (url, signal) => (await caption([url], signal))[0]!,
    batchCaptioner: caption
  }
  const embedder: EmbedderSpec = {
    provider: 'openai',
    model: 'fake-embedding',
    dim: DIM,
    paid: true,
    load: async (): Promise<Embedder> => {
      loads++
      return {
        maxBatch: () => 16,
        concurrency: 2,
        embed: async (texts) => {
          embedded.push(...texts)
          const data = new Float32Array(texts.length * DIM)
          texts.forEach((t, i) => {
            data[i * DIM + (t.length % DIM)] = 1
          })
          return { data, dim: DIM }
        }
      }
    }
  }
  const providers: PaidProviders = { captioner, embedders: [embedder] }
  return {
    providers,
    captioned,
    embedded,
    loads: () => loads,
    reset: () => {
      captioned.length = embedded.length = 0
    }
  }
}

const tweets = (
  rows: Array<[id: string, text: string, media?: string[]]>
): PaidInput => ({
  ids: rows.map(([id]) => id),
  texts: rows.map(([, text]) => text),
  media: rows.map(([, , media]) => media ?? [])
})

const BEFORE = tweets([
  ['1', 'shipping the new compiler', ['https://img/a.jpg']],
  ['2', 'galaxy maps are fun'],
  ['3', 'look at this chart', ['https://img/b.jpg']]
])
// After a sync: two new tweets (one with an image), and tweet 1 gained an image.
const AFTER = tweets([
  [
    '1',
    'shipping the new compiler',
    ['https://img/a.jpg', 'https://img/d.jpg']
  ],
  ['2', 'galaxy maps are fun'],
  ['3', 'look at this chart', ['https://img/b.jpg']],
  ['4', 'a brand new tweet'],
  ['5', 'and a new photo', ['https://img/c.jpg']]
])

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'murmuration-paid-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (
  input: PaidInput,
  fake: ReturnType<typeof fakeOpenAI>,
  options: Partial<PaidOptions> = {}
) =>
  withBuildLock(dir, (lock) =>
    captionAndEmbed(input, {
      cacheDir: dir,
      providers: fake.providers,
      lock,
      log: () => {},
      ...options
    })
  )

describe('spend plan', () => {
  it('counts only uncached work, including tweets whose new captions change their input', async () => {
    const fake = fakeOpenAI()
    const empty = await planPaidWork(BEFORE, {
      cacheDir: dir,
      providers: fake.providers
    })
    expect(empty).toMatchObject({
      paid: true,
      provider: 'openai',
      captionModel: 'fake-vision',
      embeddingModel: 'fake-embedding',
      captions: 2,
      embeddings: 3
    })

    await run(BEFORE, fake, { spend: 'approved' })
    const cached = await planPaidWork(BEFORE, {
      cacheDir: dir,
      providers: fake.providers
    })
    expect(cached).toMatchObject({ captions: 0, embeddings: 0 })

    // Images c and d; tweets 4 and 5, and tweet 1 for its new caption.
    const after = await planPaidWork(AFTER, {
      cacheDir: dir,
      providers: fake.providers
    })
    expect(after).toMatchObject({ captions: 2, embeddings: 3 })
    // Planning requested nothing.
    expect(fake.captioned).toHaveLength(2)
  })

  it('reads its caps from the environment', () => {
    expect(spendCaps({})).toEqual(DEFAULT_CAPS)
    expect(
      spendCaps({
        MURMURATION_MAX_NEW_CAPTIONS: '5',
        MURMURATION_MAX_NEW_EMBEDDINGS: '0'
      })
    ).toEqual({ captions: 5, embeddings: 0 })
    expect(() => spendCaps({ MURMURATION_MAX_NEW_CAPTIONS: 'lots' })).toThrow(
      /MURMURATION_MAX_NEW_CAPTIONS/
    )
  })
})

describe('spend caps', () => {
  it('pays for a small incremental build automatically', async () => {
    const fake = fakeOpenAI()
    await run(BEFORE, fake, { spend: 'approved' })
    fake.reset()
    const result = await run(AFTER, fake, {
      caps: { captions: 2, embeddings: 3 }
    })
    expect(result.held).toBeUndefined()
    expect(result.warnings).toEqual([])
    expect(fake.captioned.sort()).toEqual([
      'https://img/c.jpg',
      'https://img/d.jpg'
    ])
    expect(fake.embedded).toHaveLength(3)
    expect(result.captions[0]).toEqual(['a photo of a.jpg', 'a photo of d.jpg'])
  })

  it('over the caps, a capped build pays nothing, uses the cache and says what is waiting', async () => {
    const fake = fakeOpenAI()
    await run(BEFORE, fake, { spend: 'approved' })
    fake.reset()
    const result = await run(AFTER, fake, {
      caps: { captions: 1, embeddings: 100 }
    })
    expect(fake.captioned).toEqual([])
    expect(fake.embedded).toEqual([])
    expect(result.held).toEqual({ reason: 'cap', captions: 2, embeddings: 3 })
    expect(result.warnings).toEqual([
      expect.stringContaining('2 new image captions and 3 new embeddings')
    ])
    expect(result.warnings[0]).toContain('`pnpm export --yes`')
    // Cached captions and vectors still count; the rest is imputed later.
    expect(result.captions[0]).toEqual(['a photo of a.jpg'])
    expect(result.embedding).toMatchObject({ embedded: 0, missing: 2 })
  })

  it('over the caps, a strict build stops before requesting anything; approval pays', async () => {
    const fake = fakeOpenAI()
    const caps = { captions: 1, embeddings: 1 }
    const error = await run(AFTER, fake, { spend: 'strict', caps }).catch(
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(SpendHeldError)
    expect((error as SpendHeldError).held).toEqual({
      reason: 'cap',
      captions: 4,
      embeddings: 5
    })
    expect(String(error)).toMatch(/pnpm export --plan.*pnpm export --yes/)
    expect(fake.captioned).toEqual([])
    expect(fake.loads()).toBe(0)

    const approved = await run(AFTER, fake, { spend: 'approved', caps })
    expect(approved.held).toBeUndefined()
    expect(fake.captioned).toHaveLength(4)
    expect(fake.embedded).toHaveLength(5)
  })

  it("doesn't cap a free local embedder", async () => {
    const fake = fakeOpenAI()
    const local = { ...fake.providers.embedders[0], paid: false }
    const result = await run(AFTER, fake, {
      providers: { embedders: [local] },
      caps: { captions: 0, embeddings: 0 }
    })
    expect(result.plan.paid).toBe(false)
    expect(result.held).toBeUndefined()
    expect(fake.embedded).toHaveLength(5)
  })
})

describe('pause switch', () => {
  it('holds paid work back while .cache/PAUSE exists', async () => {
    const fake = fakeOpenAI()
    writeFileSync(pauseFile(dir), '')
    const result = await run(AFTER, fake)
    expect(result.held).toEqual({ reason: 'pause', captions: 4, embeddings: 5 })
    expect(result.warnings[0]).toMatch(/paused by \.cache\/PAUSE/)
    expect(fake.captioned).toEqual([])
    expect(stillHeld(result.held!, dir)).toBe(true)

    await expect(run(AFTER, fake, { spend: 'approved' })).rejects.toThrow(
      /paused by \.cache\/PAUSE/
    )
    expect(fake.captioned).toEqual([])
  })

  it('stops a running fan-out, keeps what finished, and resumes once deleted', async () => {
    // 400 images: 50 requests of 8, 16 in flight.
    const media = Array.from({ length: 400 }, (_, i) => [
      `https://img/${i}.jpg`
    ])
    const input: PaidInput = {
      ids: media.map((_, i) => String(i)),
      texts: media.map((_, i) => `tweet ${i}`),
      media
    }
    const caps = { captions: 1000, embeddings: 1000 }
    let first = true
    const fake = fakeOpenAI({
      onCaption: async () => {
        // Someone runs `touch .cache/PAUSE` while 16 requests are in flight.
        if (first) setTimeout(() => writeFileSync(pauseFile(dir), ''), 1)
        first = false
        await sleep(5)
      }
    })
    const paused = await run(input, fake, { caps })
    expect(paused.held?.reason).toBe('pause')
    // The 16 requests already in flight finished; nothing else started.
    expect(fake.captioned).toHaveLength(128)
    expect(paused.held?.captions).toBe(272)
    expect(fake.embedded).toEqual([])
    expect(stillHeld(paused.held!, dir)).toBe(true)

    rmSync(pauseFile(dir))
    expect(stillHeld(paused.held!, dir)).toBe(false)
    fake.reset()
    const resumed = await run(input, fake, { caps })
    expect(resumed.held).toBeUndefined()
    expect(fake.captioned).toHaveLength(272)
    expect(fake.embedded).toHaveLength(400)
  })
})

describe('paid requests', () => {
  it('need the build lock', async () => {
    const fake = fakeOpenAI()
    const stale = { file: lockFile(dir), held: () => false }
    await expect(
      captionAndEmbed(AFTER, {
        cacheDir: dir,
        providers: fake.providers,
        lock: stale
      })
    ).rejects.toThrow(/need the build lock/)
    await expect(
      captionTweetImages(AFTER.media, {
        cacheDir: dir,
        captioner: fake.providers.captioner!
      })
    ).rejects.toThrow(/need the build lock/)
    expect(fake.captioned).toEqual([])
  })

  it('stop promptly when cancelled and keep what finished', async () => {
    const media = Array.from({ length: 400 }, (_, i) => [
      `https://img/${i}.jpg`
    ])
    const input: PaidInput = {
      ids: media.map((_, i) => String(i)),
      texts: media.map((_, i) => `tweet ${i}`),
      media
    }
    const controller = new AbortController()
    let calls = 0
    const fake = fakeOpenAI({
      onCaption: async (_, signal) => {
        // The first request returns; the rest hang until cancelled.
        if (calls++ === 0) return
        setTimeout(() => controller.abort(new Error('server restarting')), 20)
        await sleep(10_000, undefined, { signal })
      }
    })
    const t0 = performance.now()
    await expect(
      run(input, fake, {
        caps: { captions: 1000, embeddings: 1000 },
        signal: controller.signal
      })
    ).rejects.toThrow('server restarting')
    expect(performance.now() - t0).toBeLessThan(2000)
    // The first request's slot went to a 17th; then nothing new started.
    expect(calls).toBe(17)
    expect(fake.loads()).toBe(0)
    const cached = readFileSync(
      path.join(dir, 'captions-fake-vision.jsonl'),
      'utf8'
    )
    expect(cached.trim().split('\n')).toHaveLength(8)
  })
})
