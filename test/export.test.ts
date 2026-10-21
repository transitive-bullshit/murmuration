import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { writeExport } from '../src/server/exporter'
import {
  DmFingerprints,
  LEAK_RUN,
  auditExport,
  normalizeForAudit,
  toPublicDataset
} from '../src/server/publicExport'
import { DM, PUBLIC_TWEET, fixture } from './fixtures/dataset'

function fingerprints(...dms: string[]) {
  const fp = new DmFingerprints()
  for (const dm of dms) fp.addMessage(dm)
  return fp
}

describe('toPublicDataset', () => {
  test('keeps DM counts and bookmarks, drops the archive location', () => {
    const out = toPublicDataset(fixture())
    expect(out.meta.dbPath).toBe('birdclaw.sqlite')
    expect(out.people.dmIn).toEqual([3])
    expect(out.people.dmOut).toEqual([1])
    expect(out.tweets.kind).toEqual([0, 2])
    expect(out.tweets.text[1]).toBe('a bookmark')
  })

  test('drops build warnings', () => {
    const ds = fixture()
    ds.meta.warnings = ['Describing images stopped early']
    expect(toPublicDataset(ds).meta).not.toHaveProperty('warnings')
  })

  test('refuses fields nobody allowlisted', () => {
    const ds = fixture()
    Object.assign(ds.people, { dmText: ['secret'] })
    expect(() => toPublicDataset(ds)).toThrow(/people\.dmText/)
    const nested = fixture()
    Object.assign(nested.meta.counts, { dmWords: 3 })
    expect(() => toPublicDataset(nested)).toThrow(/meta\.counts\.dmWords/)
  })
})

describe('auditExport', () => {
  test('finds a whole DM anywhere and reports only where', () => {
    const ds = toPublicDataset(fixture())
    ds.tweets.caption[1] = `Screenshot reads: ${DM.toUpperCase()}`
    const audit = auditExport(ds, fingerprints(DM))
    expect(audit.leaks).toEqual([
      `tweets.caption[1], tweet 2 (${normalizeForAudit(DM).length} characters of a DM)`
    ])
    expect(audit.leaks.join(' ')).not.toContain('Series B')
  })

  test('catches partial copies with different whitespace', () => {
    const ds = toPublicDataset(fixture())
    // Any copied stretch of 98+ characters spans two adjacent fingerprints.
    const excerpt = DM.slice(7, 105).replace(/ /g, '\n  ')
    ds.inflections.push({
      id: 'x',
      metric: 'followers',
      kind: 'spike',
      t: 0,
      t0: 0,
      t1: 0,
      gain: 0,
      baseline: 0,
      z: 0,
      ratio: 0,
      summary: excerpt,
      causes: [],
      notableFollowers: []
    })
    const [leak] = auditExport(ds, fingerprints(DM)).leaks
    expect(leak).toMatch(
      /^inflections\[0\]\.summary \(\d+ characters of a DM\)$/
    )
  })

  test('counts short shared phrases without blocking', () => {
    const ds = toPublicDataset(fixture())
    // One fingerprint's worth (an article title, say) is not a leak.
    ds.tweets.caption[0] = `An article: ${DM.slice(20, 20 + LEAK_RUN - 1)}…`
    const audit = auditExport(ds, fingerprints(DM))
    expect(audit.leaks).toEqual([])
    expect(audit.sharedPhrases).toBe(1)
  })

  test('catches short DMs copied whole', () => {
    const short = 'Can you intro me to your friend at the fund?'
    const ds = toPublicDataset(fixture())
    ds.people.outlierReason[0] = `asked: ${short}`
    expect(auditExport(ds, fingerprints(short)).leaks).toEqual([
      `people.outlierReason[0] (${short.length} characters of a DM)`
    ])
  })

  test('allows text that was public anyway', () => {
    const fp = fingerprints(`look at this: ${PUBLIC_TWEET}`)
    fp.addPublic(PUBLIC_TWEET)
    const audit = auditExport(toPublicDataset(fixture()), fp)
    expect(audit.leaks).toEqual([])
    expect(audit.publicOverlap).toBeGreaterThan(0)
  })

  test('skips DMs too short to tell apart from ordinary phrases', () => {
    const audit = auditExport(
      toPublicDataset(fixture()),
      fingerprints('ok!', 'a bookmark', DM)
    )
    expect(audit.messages).toBe(3)
    expect(audit.fingerprinted).toBe(1)
    expect(audit.leaks).toEqual([])
  })

  test('flags forbidden values like secrets and local paths', () => {
    const ds = fixture()
    const audit = auditExport(ds, fingerprints(), [
      { label: 'the archive path', value: ds.meta.dbPath }
    ])
    expect(audit.leaks).toEqual(['meta.dbPath (the archive path)'])
  })
})

describe('auditExport with public passages', () => {
  test('private text next to a public quote is still caught', () => {
    const quote = PUBLIC_TWEET
    const secret = 'and between us the round closes Friday at forty million'
    const dm = `${quote} ${secret}`
    const fp = fingerprints(dm)
    fp.addPublic(quote)
    const ds = toPublicDataset(fixture())
    ds.tweets.caption[0] = dm
    expect(auditExport(ds, fp).leaks).toHaveLength(1)
    // The quote alone is public and fine.
    ds.tweets.caption[0] = quote
    expect(auditExport(ds, fp).leaks).toEqual([])
  })
})

describe('writeExport', () => {
  const manifest = (exportedAt: string) => ({
    format: 1,
    exportedAt,
    revision: 1,
    source: { size: 1, mtimeMs: 1 },
    audit: {
      messages: 0,
      fingerprinted: 0,
      publicOverlap: 0,
      sharedPhrases: 0,
      strings: 0,
      chars: 0,
      leaks: []
    }
  })

  test('keeps an identical export byte-for-byte, timestamp included', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'murmuration-export-'))
    try {
      const file = path.join(dir, 'data', 'dataset.json')
      const data = toPublicDataset(fixture())
      const first = writeExport(file, data, manifest('2026-01-01T00:00:00Z'))
      expect(first.unchanged).toBe(false)
      const before = readFileSync(file)

      const again = writeExport(file, data, manifest('2026-02-02T00:00:00Z'))
      expect(again.unchanged).toBe(true)
      expect(again.manifest.exportedAt).toBe('2026-01-01T00:00:00Z')
      expect(readFileSync(file).equals(before)).toBe(true)

      data.meta.counts.mine += 1
      const changed = writeExport(file, data, manifest('2026-03-03T00:00:00Z'))
      expect(changed.unchanged).toBe(false)
      expect(readFileSync(file, 'utf8')).toContain('2026-03-03T00:00:00Z')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
