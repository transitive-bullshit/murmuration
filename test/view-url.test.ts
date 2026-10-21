import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { VIEWS, viewFromPath } from '../src/client/views'

describe('view URLs', () => {
  it('reads the view from the path', () => {
    expect(viewFromPath('/strata')).toBe('strata')
    expect(viewFromPath('/orbit/')).toBe('orbit')
    expect(viewFromPath('/app/growth', '/app/')).toBe('growth')
    expect(viewFromPath('/')).toBeUndefined()
    expect(viewFromPath('/llms.txt')).toBeUndefined()
  })

  it('serves the app at every view path on Vercel', () => {
    const config = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../vercel.json'), 'utf8')
    ) as { rewrites: { source: string; destination: string }[] }
    const rewrite = config.rewrites.find(
      (r) => r.destination === '/index.html'
    )!
    const listed = /\(([^)]+)\)/.exec(rewrite.source)![1]!.split('|')
    expect(listed.toSorted()).toEqual(VIEWS.map((v) => v.id).toSorted())
  })
})
