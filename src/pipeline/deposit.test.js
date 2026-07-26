// pipeline/deposit.test.js — pure logic of the taxonomy tidy pass: counting papers per
// field, and sanitizing Claude's proposed merges before they're applied. (Store-backed
// behavior — filePaper, consolidateDomains' apply step — needs IndexedDB and is exercised live.)

import { describe, it, expect } from 'vitest'
import { domainCounts, mergeCandidates, pickMerges, SPARSE_MIN, TIDY_MIN_FIELDS } from './deposit.js'

describe('domainCounts', () => {
  it('counts papers per domain key', () => {
    const counts = domainCounts([
      { domain: 'vascular-surgery' },
      { domain: 'vascular-surgery' },
      { domain: 'health-data-science' },
    ])
    expect(counts.get('vascular-surgery')).toBe(2)
    expect(counts.get('health-data-science')).toBe(1)
  })

  it('skips unfiled papers and tolerates junk', () => {
    const counts = domainCounts([{ domain: null }, {}, null, { domain: 'ai' }])
    expect(counts.size).toBe(1)
    expect(counts.get('ai')).toBe(1)
  })

  it('handles no papers', () => {
    expect(domainCounts([]).size).toBe(0)
    expect(domainCounts(undefined).size).toBe(0)
  })
})

describe('mergeCandidates', () => {
  // Her library: the specialty Claude minted plus fields she typed in Settings, most of them
  // still empty (she added them to steer filing before the next re-file).
  const DOMAINS = [
    { key: 'vascular-surgery', label: 'Vascular Surgery' },
    { key: 'clinical-ai', label: 'Clinical AI' },
    { key: 'ai-ml', label: 'AI / ML' },
    { key: 'limb', label: 'Limb' },
  ]
  const counts = new Map([['vascular-surgery', 15], ['clinical-ai', 1], ['ai-ml', 0], ['limb', 0]])

  it('offers up only the under-populated fields Claude minted', () => {
    expect([...mergeCandidates(DOMAINS, counts)]).toEqual(['clinical-ai'])
  })

  it('an empty field is someone typing, not Claude filing — never a candidate', () => {
    const cands = mergeCandidates(DOMAINS, counts)
    expect(cands.has('ai-ml')).toBe(false)
    expect(cands.has('limb')).toBe(false)
  })

  it('a healthy field is never a candidate', () => {
    expect(mergeCandidates(DOMAINS, counts).has('vascular-surgery')).toBe(false)
  })

  it("skips the fields the user owns even when they've been filled", () => {
    const filled = new Map(counts).set('ai-ml', 1)
    expect([...mergeCandidates(DOMAINS, filled, new Set(['ai-ml']))]).toEqual(['clinical-ai'])
  })

  it('tolerates junk', () => {
    expect(mergeCandidates(undefined, new Map()).size).toBe(0)
    expect(mergeCandidates([], new Map()).size).toBe(0)
  })
})

describe('pickMerges', () => {
  const keys = new Set(['vascular', 'ai', 'clinical-ai', 'genomics'])
  const sparse = new Set(['clinical-ai', 'genomics'])

  it('keeps a valid sparse → healthy merge', () => {
    expect(pickMerges([{ from: 'clinical-ai', into: 'ai' }], { keys, sparse })).toEqual([
      { from: 'clinical-ai', into: 'ai' },
    ])
  })

  it('drops self-merges and unknown keys', () => {
    expect(pickMerges([{ from: 'ai', into: 'ai' }], { keys, sparse })).toEqual([])
    expect(pickMerges([{ from: 'nope', into: 'ai' }], { keys, sparse })).toEqual([])
    expect(pickMerges([{ from: 'clinical-ai', into: 'nope' }], { keys, sparse })).toEqual([])
  })

  it('never merges a healthy field away', () => {
    expect(pickMerges([{ from: 'vascular', into: 'ai' }], { keys, sparse })).toEqual([])
  })

  it('drops chains — a merge into a field that is itself being merged away', () => {
    const proposed = [
      { from: 'genomics', into: 'clinical-ai' },
      { from: 'clinical-ai', into: 'ai' },
    ]
    // genomics → clinical-ai is dropped (clinical-ai is going away); clinical-ai → ai survives
    expect(pickMerges(proposed, { keys, sparse })).toEqual([{ from: 'clinical-ai', into: 'ai' }])
  })

  it('merges each field at most once', () => {
    const proposed = [
      { from: 'clinical-ai', into: 'ai' },
      { from: 'clinical-ai', into: 'vascular' },
    ]
    expect(pickMerges(proposed, { keys, sparse })).toEqual([{ from: 'clinical-ai', into: 'ai' }])
  })

  it('tolerates junk and empty proposals', () => {
    expect(pickMerges(null, { keys, sparse })).toEqual([])
    expect(pickMerges([null, {}, { from: 'clinical-ai' }], { keys, sparse })).toEqual([])
  })

  // A field the user typed in Settings is her taxonomy, not Claude's. It starts empty (that's
  // how you steer filing ahead of the papers), so the tidy pass would otherwise absorb it and
  // delete it on the next re-file — silently undoing her edit.
  describe("the user's own fields", () => {
    const protectedKeys = new Set(['genomics'])

    it('are never merged away, however sparse', () => {
      expect(pickMerges([{ from: 'genomics', into: 'ai' }], { keys, sparse, protectedKeys })).toEqual([])
    })

    it('can still absorb a field Claude minted', () => {
      expect(pickMerges([{ from: 'clinical-ai', into: 'genomics' }], { keys, sparse, protectedKeys })).toEqual([
        { from: 'clinical-ai', into: 'genomics' },
      ])
    })

    it('protect nothing extra when the set is empty (default)', () => {
      expect(pickMerges([{ from: 'genomics', into: 'ai' }], { keys, sparse })).toEqual([
        { from: 'genomics', into: 'ai' },
      ])
    })
  })
})

describe('tidy gating constants', () => {
  it('sparse threshold and field floor are sane (young taxonomies are left alone)', () => {
    expect(SPARSE_MIN).toBeGreaterThanOrEqual(2)
    expect(TIDY_MIN_FIELDS).toBeGreaterThanOrEqual(4)
  })
})
