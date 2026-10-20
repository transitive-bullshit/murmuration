import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import type { Plugin } from 'vite'

import { DatasetStore } from './cache'
import { loadLocalEnv } from './env'
import {
  EXPORT_FILE,
  ExportStore,
  requireExport,
  staleReason
} from './exporter'

type Next = (err?: unknown) => void

/**
 * Dev: serves the local analytics API from the Vite dev server, backed by
 * data/dataset.json when it exists (`pnpm export`), else by a live build from
 * your Birdclaw archive:
 *
 *   GET  /api/status   build progress + whether the archive changed since
 *   GET  /api/dataset  gzipped dataset JSON
 *   POST /api/rebuild  re-read the archive (and re-export, when serving one)
 *
 * Build: production is static. It fails without the export, ships it as
 * dist/data/dataset.json, and has no API or archive access.
 */
export function murmurationData(): Plugin {
  let store: DatasetStore | undefined
  let snapshot: ExportStore | undefined
  let published: Buffer | undefined
  let base = '/'

  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: Next
  ) => {
    if (!req.url?.startsWith('/api/') || !store || !snapshot) return next()
    const url = new URL(req.url, 'http://localhost')
    const exported = snapshot.available()
    try {
      if (url.pathname === '/api/status') {
        // E.g. the export was deleted while the server ran: build instead.
        if (!exported && !store.status().ready) void store.ensure()
        return json(
          res,
          exported
            ? snapshot.status()
            : { ...store.status(), source: 'archive' }
        )
      }
      if (url.pathname === '/api/dataset') {
        const gz = exported ? snapshot.get() : await store.get()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
          res.setHeader('Content-Encoding', 'gzip')
          return res.end(gz)
        }
        return res.end(gunzipSync(gz))
      }
      if (url.pathname === '/api/rebuild' && req.method === 'POST') {
        if (exported) snapshot.rebuild()
        else void store.ensure(true)
        return json(res, exported ? snapshot.status() : store.status())
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
    config(config, env) {
      if (env.command !== 'build') return
      const root = path.resolve(config.root ?? process.cwd())
      // Throws (failing the build) when there's no usable export.
      const { raw, manifest } = requireExport(root)
      const stale = staleReason(manifest)
      if (stale)
        console.warn(
          `[murmuration] publishing ${EXPORT_FILE} from ${manifest.exportedAt.slice(0, 10)}, but ${stale}; run \`pnpm export\` to refresh it`
        )
      published = raw
      return {
        define: {
          'import.meta.env.MURMURATION_DATASET_BYTES': String(raw.byteLength)
        }
      }
    },
    configResolved(config) {
      base = config.base
      loadLocalEnv(config.root)
      store = new DatasetStore(path.join(config.root, '.cache'))
      snapshot = new ExportStore(config.root, store)
    },
    configureServer(server) {
      // Without an export, start reading the archive right away so it's warm
      // by the time the browser asks for it.
      if (!snapshot?.available()) void store?.ensure()
      server.middlewares.use((req, res, next) => void handler(req, res, next))
    },
    transformIndexHtml() {
      if (!published) return
      // Start downloading the data alongside the app's own scripts.
      return [
        {
          tag: 'link',
          attrs: {
            rel: 'preload',
            href: `${base}${EXPORT_FILE}`,
            as: 'fetch',
            crossorigin: true
          },
          injectTo: 'head'
        }
      ]
    },
    generateBundle() {
      if (published)
        this.emitFile({
          type: 'asset',
          fileName: EXPORT_FILE,
          source: published
        })
    }
  }
}

function json(res: ServerResponse, body: unknown) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}
