import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import type { Plugin } from 'vite'

import { DatasetStore } from './cache'

type Next = (err?: unknown) => void

/**
 * Serves the local analytics API from the Vite dev/preview server:
 *
 *   GET  /api/status   build progress + whether the archive changed since
 *   GET  /api/dataset  gzipped dataset JSON
 *   POST /api/rebuild  re-read the archive
 */
export function murmurationData(): Plugin {
  let store: DatasetStore | undefined

  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: Next
  ) => {
    if (!req.url?.startsWith('/api/') || !store) return next()
    const url = new URL(req.url, 'http://localhost')
    try {
      if (url.pathname === '/api/status') {
        return json(res, store.status())
      }
      if (url.pathname === '/api/dataset') {
        const gz = await store.get()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
          res.setHeader('Content-Encoding', 'gzip')
          return res.end(gz)
        }
        return res.end(gunzipSync(gz))
      }
      if (url.pathname === '/api/rebuild' && req.method === 'POST') {
        void store.ensure(true)
        return json(res, store.status())
      }
      res.statusCode = 404
      return json(res, { error: 'Not found' })
    } catch (err) {
      res.statusCode = 500
      return json(res, {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return {
    name: 'murmuration-data',
    configResolved(config) {
      store = new DatasetStore(path.join(config.root, '.cache'))
    },
    configureServer(server) {
      // Start reading the archive right away so it's warm by the time the
      // browser asks for it.
      void store?.ensure()
      server.middlewares.use((req, res, next) => void handler(req, res, next))
    },
    configurePreviewServer(server) {
      void store?.ensure()
      server.middlewares.use((req, res, next) => void handler(req, res, next))
    }
  }
}

function json(res: ServerResponse, body: unknown) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}
