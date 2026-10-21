import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  embedTexts,
  embeddingInput,
  type Embedder,
  type EmbedderSpec
} from '../src/server/embed'
import { captionImages, planCaptions } from '../src/server/embed/captions'
import { openaiCaptioner, openaiEmbedder } from '../src/server/embed/openai'

const DIM = 8

/** Deterministic fake vectors derived from the text; counts what it embeds. */
function fakeSpec(options: { failAfter?: number } = {}) {
  const seen: string[] = []
  let calls = 0
  const vector = (text: string) => {
    const v = new Float32Array(DIM)
    for (let i = 0; i < text.length; i++)
      v[(text.charCodeAt(i) * (i + 1)) % DIM]! += 1
    const norm = Math.hypot(...v) || 1
    return v.map((x) => x / norm)
  }
  const spec: EmbedderSpec = {
    provider: 'fake',
    model: 'fake-model',
    dim: DIM,
    load: async (): Promise<Embedder> => ({
      maxBatch: () => 2,
      concurrency: 1,
      embed: async (texts) => {
        if (options.failAfter !== undefined && calls >= options.failAfter)
          throw new Error('offline')
        calls++
        seen.push(...texts)
        const data = new Float32Array(texts.length * DIM)
        texts.forEach((t, i) => data.set(vector(t), i * DIM))
        return { data, dim: DIM }
      }
    })
  }
  return { spec, seen, vector }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'murmuration-embed-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('embeddingInput', () => {
  it('cleans tweet text and appends image captions', () => {
    expect(
      embeddingInput(
        '@a @b Shipping it &amp; more https://t.co/xyz {learnmore}',
        ['A cat on a laptop']
      )
    ).toBe('Shipping it & more\nImage: A cat on a laptop')
    expect(embeddingInput('https://t.co/xyz 🔥')).toBe('')
    expect(embeddingInput('', ['A chart of GPU prices'])).toBe(
      'Image: A chart of GPU prices'
    )
  })
})

describe('embedTexts', () => {
  const ids = ['1', '2', '3', '4', '5']
  const inputs = [
    'hello world',
    'typescript compiler',
    '',
    'hello world',
    'galaxy map'
  ]

  it('caches per tweet and only re-embeds new or changed inputs', async () => {
    const first = fakeSpec()
    const a = await embedTexts(ids, inputs, {
      cacheDir: dir,
      embedder: first.spec
    })
    expect(a.embedded).toBe(4)
    expect(a.dim).toBe(DIM)
    // Empty inputs get zero vectors; the rest are unit length and close to the source.
    expect(
      Array.from(a.vectors.subarray(2 * DIM, 3 * DIM)).every((v) => v === 0)
    ).toBe(true)
    for (const i of [0, 1, 3, 4]) {
      const v = a.vectors.subarray(i * DIM, (i + 1) * DIM)
      const truth = first.vector(inputs[i]!)
      let dot = 0
      for (let t = 0; t < DIM; t++) dot += v[t]! * truth[t]!
      expect(dot).toBeGreaterThan(0.999)
    }

    const second = fakeSpec()
    const b = await embedTexts(ids, inputs, {
      cacheDir: dir,
      embedder: second.spec
    })
    expect(b.embedded).toBe(0)
    expect(second.seen).toEqual([])
    expect(Array.from(b.vectors)).toEqual(Array.from(a.vectors))

    const third = fakeSpec()
    const changed = [...inputs.slice(0, 4), 'galaxy map v2']
    const c = await embedTexts([...ids, '6'], [...changed, 'brand new tweet'], {
      cacheDir: dir,
      embedder: third.spec
    })
    expect(c.embedded).toBe(2)
    expect(third.seen.sort()).toEqual(['brand new tweet', 'galaxy map v2'])
  })

  it('survives a failed batch and retries it on the next run', async () => {
    const failing = fakeSpec({ failAfter: 1 })
    const lines: string[] = []
    const partial = await embedTexts(ids, inputs, {
      cacheDir: dir,
      embedder: failing.spec,
      log: (line) => lines.push(line)
    })
    // First batch of two succeeded, the second failed: no throw, zero rows.
    expect(failing.seen).toHaveLength(2)
    expect(partial.missing).toBe(2)
    expect(partial.embedded).toBe(2)
    expect(partial.warning).toMatch(/2 of 4 tweets/)
    expect(lines).toHaveLength(1)
    expect(Array.from(partial.vectors).every(Number.isFinite)).toBe(true)

    const resume = fakeSpec()
    const result = await embedTexts(ids, inputs, {
      cacheDir: dir,
      embedder: resume.spec
    })
    expect(result.embedded).toBe(2)
    expect(result.missing).toBe(0)
    expect(resume.seen).toHaveLength(2)
  })
})

describe('captionImages', () => {
  const urls = [
    'https://img/a.jpg',
    'https://img/b.jpg',
    'https://img/c.jpg',
    'https://img/a.jpg'
  ]

  it('captions each URL once and resumes from the cache', async () => {
    const file = path.join(dir, 'captions.jsonl')
    const asked: string[] = []
    const captioner = async (url: string) => {
      asked.push(url)
      return `caption of ${url.slice(-5)}`
    }
    const first = await captionImages(urls, {
      file,
      captioner,
      concurrency: 2,
      log: () => {}
    })
    expect(first.requested).toBe(3)
    expect(first.captions.get('https://img/b.jpg')).toBe('caption of b.jpg')
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3)

    const second = await captionImages([...urls, 'https://img/d.jpg'], {
      file,
      captioner,
      log: () => {}
    })
    expect(second.requested).toBe(1)
    expect(asked).toHaveLength(4)
    expect(second.captions.size).toBe(4)
  })

  it('records failures and retries them only after a cooldown', async () => {
    const file = path.join(dir, 'captions.jsonl')
    let now = 1_000_000
    let broken = true
    const captioner = async (url: string) => {
      if (broken && url.endsWith('b.jpg')) throw new Error('bad image')
      return 'ok'
    }
    const options = {
      file,
      captioner,
      classify: () => 'item' as const,
      now: () => now,
      log: () => {}
    }
    const first = await captionImages(urls, options)
    expect(first.failed).toBe(1)
    expect(first.captions.has('https://img/b.jpg')).toBe(false)

    // Immediately after: not retried.
    expect((await captionImages(urls, options)).requested).toBe(0)
    // After the cooldown: retried, and this time it works.
    now += 7 * 3600_000
    broken = false
    const third = await captionImages(urls, options)
    expect(third.requested).toBe(1)
    expect(third.captions.get('https://img/b.jpg')).toBe('ok')
  })

  it('captions several images per request and isolates a bad one', async () => {
    const file = path.join(dir, 'captions.jsonl')
    const batches: string[][] = []
    const singles: string[] = []
    const result = await captionImages(['u1', 'u2', 'bad', 'u4', 'u5'], {
      file,
      groupSize: 2,
      batchCaptioner: async (group) => {
        batches.push(group)
        if (group.includes('bad')) throw new Error('400 invalid image')
        return group.map((u) => `batch ${u}`)
      },
      captioner: async (url) => {
        singles.push(url)
        if (url === 'bad') throw new Error('400 invalid image')
        return `single ${url}`
      },
      log: () => {}
    })
    // [u1, u2] batched; [bad, u4] fell back to singles; a lone [u5] goes single.
    expect(batches).toHaveLength(2)
    expect(singles.sort()).toEqual(['bad', 'u4', 'u5'])
    expect(result.failed).toBe(1)
    expect(result.captions.get('u1')).toBe('batch u1')
    expect(result.captions.get('u4')).toBe('single u4')
    expect(result.captions.has('bad')).toBe(false)
    expect(result.error).toBeUndefined()
  })

  it('records deleted images as gone, not failures, and never asks again', async () => {
    const file = path.join(dir, 'captions.jsonl')
    let now = 1_000_000
    // 12 groups in a row of deleted images: as failures they'd stop the run.
    const deleted = Array.from({ length: 24 }, (_, i) => `deleted-${i}`)
    const urls = [...deleted, 'u1', 'u2']
    const asked: string[] = []
    const checked: string[] = []
    const options = {
      file,
      groupSize: 2,
      concurrency: 1,
      batchCaptioner: async (group: string[]) => {
        asked.push(...group)
        if (group.some((u) => u.startsWith('deleted')))
          throw new Error('400 Bad Request')
        return group.map((u) => `batch ${u}`)
      },
      captioner: async (url: string) => {
        asked.push(url)
        if (url.startsWith('deleted')) throw new Error('400 Bad Request')
        return `single ${url}`
      },
      gone: async (url: string) => {
        checked.push(url)
        return url.startsWith('deleted')
      },
      now: () => now,
      log: () => {}
    }
    const first = await captionImages(urls, options)
    expect(first).toMatchObject({ requested: 26, failed: 0, missing: 24 })
    expect(first.error).toBeUndefined()
    expect(first.warning).toBeUndefined()
    expect(first.captions.get('u1')).toBe('batch u1')
    // Only failed requests are checked.
    expect(checked.sort()).toEqual([...deleted].sort())

    // Gone for good: not planned or requested again, even long after.
    now += 30 * 24 * 3600_000
    expect(planCaptions(urls, { file, now: () => now }).todo).toEqual([])
    asked.length = 0
    expect((await captionImages(urls, options)).requested).toBe(0)
    expect(asked).toEqual([])
  })

  it('stops on account-level errors but keeps finished captions', async () => {
    const file = path.join(dir, 'captions.jsonl')
    const result = await captionImages(urls, {
      file,
      concurrency: 1,
      captioner: async (url) => {
        if (url.endsWith('b.jpg')) throw new Error('401')
        return 'ok'
      },
      classify: () => 'fatal',
      log: () => {}
    })
    expect(result.error).toBeInstanceOf(Error)
    expect(result.captions.size).toBe(1)
    // Fatal errors aren't recorded as per-image failures, so the next run retries.
    const next = await captionImages(urls, {
      file,
      captioner: async () => 'ok',
      log: () => {}
    })
    expect(next.requested).toBe(2)
  })
})

describe('OpenAI client', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })

  it('embeds with the configured model and restores input order', async () => {
    const requests: Array<{ url: string; auth: string | null; body: any }> = []
    const fetch = async (request: Request) => {
      requests.push({
        url: request.url,
        auth: request.headers.get('authorization'),
        body: await request.json()
      })
      const embedding = (x: number) => {
        const v = new Float32Array(1024)
        v[0] = x
        return Buffer.from(v.buffer).toString('base64')
      }
      return json({
        data: [
          { index: 1, embedding: embedding(2) },
          { index: 0, embedding: embedding(1) }
        ]
      })
    }
    const embedder = await openaiEmbedder({ apiKey: 'test-key', fetch }).load()
    const { data, dim } = await embedder.embed(['first', 'second'])
    expect(dim).toBe(1024)
    expect(data[0]).toBe(1)
    expect(data[1024]).toBe(2)
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/embeddings')
    expect(requests[0]!.auth).toBe('Bearer test-key')
    expect(requests[0]!.body).toMatchObject({
      model: 'text-embedding-3-large',
      dimensions: 1024,
      encoding_format: 'base64',
      input: ['first', 'second']
    })
  })

  it('retries rate limits and reads the caption from the Responses API', async () => {
    let attempts = 0
    const fetch = async (request: Request) => {
      const body = await request.json()
      expect(body.input[0].content[0]).toMatchObject({
        type: 'input_image',
        image_url: 'https://pbs.twimg.com/media/x.jpg'
      })
      if (++attempts === 1)
        return json({ error: { message: 'slow down' } }, 429)
      return json({
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [] },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: '  A terminal showing a  TypeScript error. '
              }
            ]
          }
        ]
      })
    }
    const caption = openaiCaptioner({
      apiKey: 'test-key',
      fetch,
      backoffLimit: 1
    })
    expect(await caption('https://pbs.twimg.com/media/x.jpg')).toBe(
      'A terminal showing a TypeScript error.'
    )
    expect(attempts).toBe(2)
  })
})
