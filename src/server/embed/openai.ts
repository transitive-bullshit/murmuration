import ky, { isHTTPError, type KyInstance, type Options } from 'ky'
import { z } from 'zod'

import type { BatchCaptioner, Captioner } from './captions'
import type { Embedder, EmbedderSpec } from './types'

// Minimal OpenAI REST client (embeddings + Responses API) over ky; responses
// are validated with zod. The API key is only ever sent as a bearer header.

export const EMBEDDING_MODEL = 'text-embedding-3-large'
export const EMBEDDING_DIMS = 1024
export const CAPTION_MODEL = 'gpt-6-luna'

export interface OpenAIOptions {
  apiKey: string
  /** injectable for tests */
  fetch?: (input: Request, init?: RequestInit) => Promise<Response>
  /** retry back-off cap in ms (tests shorten it) */
  backoffLimit?: number
}

export function openaiClient({
  apiKey,
  fetch,
  backoffLimit = 30_000
}: OpenAIOptions): KyInstance {
  const options: Options = {
    baseUrl: 'https://api.openai.com/v1/',
    headers: { authorization: `Bearer ${apiKey}` },
    timeout: 120_000,
    retry: {
      limit: 6,
      methods: ['post'],
      statusCodes: [408, 409, 429, 500, 502, 503, 504],
      afterStatusCodes: [413, 429, 503],
      maxRetryAfter: 60_000,
      backoffLimit,
      jitter: true,
      retryOnTimeout: true
    }
  }
  if (fetch) options.fetch = fetch
  return ky.create(options)
}

const EmbeddingResponse = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.string() }))
})

/** text-embedding-3-large at 1024 dims, up to 512 inputs per request. */
export function openaiEmbedder(options: OpenAIOptions): EmbedderSpec {
  return {
    provider: 'openai',
    model: `${EMBEDDING_MODEL}@${EMBEDDING_DIMS}`,
    dim: EMBEDDING_DIMS,
    load: async (): Promise<Embedder> => {
      const client = openaiClient(options)
      return {
        // The API caps a request at 300k tokens; budget ≤ 1 token per
        // character (CJK) so a batch of the longest inputs stays under it.
        maxBatch: (chars) =>
          Math.max(1, Math.min(512, Math.floor(250_000 / Math.max(chars, 1)))),
        concurrency: 16,
        embed: async (texts, signal) => {
          // base64 float32 keeps responses ~4× smaller and cheap to parse.
          const { data } = await client
            .post('embeddings', {
              signal,
              json: {
                model: EMBEDDING_MODEL,
                input: texts,
                dimensions: EMBEDDING_DIMS,
                encoding_format: 'base64'
              }
            })
            .json(EmbeddingResponse)
          if (data.length !== texts.length)
            throw new Error(
              `expected ${texts.length} embeddings, got ${data.length}`
            )
          const out = new Float32Array(texts.length * EMBEDDING_DIMS)
          for (const { index, embedding } of data) {
            const bytes = Buffer.from(embedding, 'base64')
            if (bytes.length !== EMBEDDING_DIMS * 4)
              throw new Error('unexpected embedding size')
            for (let t = 0; t < EMBEDDING_DIMS; t++)
              out[index * EMBEDDING_DIMS + t] = bytes.readFloatLE(t * 4)
          }
          return { data: out, dim: EMBEDDING_DIMS }
        }
      }
    }
  }
}

const ResponsesResponse = z.object({
  status: z.string().optional(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .optional()
    })
  )
})

const CAPTION_RULES = [
  'Each caption is concise and literal, at most 35 words: what is depicted, plus any important',
  "visible text, such as a screenshot's headline or a chart's subject. No speculation, no preamble."
].join(' ')

const outputText = (output: z.infer<typeof ResponsesResponse>['output']) =>
  output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join(' ')

const tidy = (caption: string) =>
  caption.replace(/\s+/gu, ' ').trim().slice(0, 400)

/**
 * One literal caption per public image URL, via the Responses API. Low image
 * detail: a one-sentence caption doesn't need high-resolution tiles.
 */
export function openaiCaptioner(options: OpenAIOptions): Captioner {
  const client = openaiClient(options)
  return async (url, signal) => {
    const { output } = await client
      .post('responses', {
        signal,
        json: {
          model: CAPTION_MODEL,
          instructions: `You caption images attached to tweets so they can be grouped by topic. Reply with one caption. ${CAPTION_RULES}`,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_image', image_url: url, detail: 'low' }]
            }
          ],
          reasoning: { effort: 'none' },
          max_output_tokens: 120,
          store: false
        }
      })
      .json(ResponsesResponse)
    return tidy(outputText(output))
  }
}

const CaptionList = z.object({ captions: z.array(z.string()) })

/** Several images per Responses call, answered as a JSON array in input order. */
export function openaiBatchCaptioner(options: OpenAIOptions): BatchCaptioner {
  const client = openaiClient(options)
  return async (urls, signal) => {
    const { output } = await client
      .post('responses', {
        signal,
        json: {
          model: CAPTION_MODEL,
          instructions: `You caption images attached to tweets so they can be grouped by topic. You get ${urls.length} images; return exactly one caption per image, in order. ${CAPTION_RULES}`,
          input: [
            {
              role: 'user',
              content: urls.map((url) => ({
                type: 'input_image',
                image_url: url,
                detail: 'low'
              }))
            }
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'captions',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  captions: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: urls.length,
                    maxItems: urls.length
                  }
                },
                required: ['captions'],
                additionalProperties: false
              }
            }
          },
          reasoning: { effort: 'none' },
          max_output_tokens: 120 * urls.length,
          store: false
        }
      })
      .json(ResponsesResponse)
    const { captions } = CaptionList.parse(JSON.parse(outputText(output)))
    if (captions.length !== urls.length)
      throw new Error(
        `expected ${urls.length} captions, got ${captions.length}`
      )
    return captions.map(tidy)
  }
}

/** Errors tied to one request's input (bad/unreachable image) rather than the account or service. */
export function isInputError(err: unknown): boolean {
  return isHTTPError(err) && [400, 413, 415, 422].includes(err.response.status)
}
