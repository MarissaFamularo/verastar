// pipeline/deposit.test.js — pure logic of the taxonomy tidy pass: counting papers per
// field, and sanitizing Claude's proposed merges before they're applied. (Store-backed
// behavior — filePaper, consolidateDomains' apply step — needs IndexedDB and is exercised live.)

import { describe, it, expect } from 'vitest'
import { domainCounts, pickMerges, SPARSE_MIN, TIDY_MIN_FIELDS } from './deposit.js'

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
})

describe('tidy gating constants', () => {
  it('sparse threshold and field floor are sane (young taxonomies are left alone)', () => {
    expect(SPARSE_MIN).toBeGreaterThanOrEqual(2)
    expect(TIDY_MIN_FIELDS).toBeGreaterThanOrEqual(4)
  })
})
