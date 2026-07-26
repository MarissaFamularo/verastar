// lib/domains.test.js — pure logic of the per-user domain registry: slugging a proposed
// label to a stable key, and palette assignment for newly minted domains. (Store-backed
// behavior — loadDomains migration, ensureDomain — needs IndexedDB and is exercised live.)

import { describe, it, expect } from 'vitest'
import { slugifyDomain, nextColor, PALETTE, LEGACY_DOMAINS, domainLabel, domainColor, DEFAULT_PAPER_COLOR, normalizeDomainName, matchDomain } from './domains.js'

describe('slugifyDomain', () => {
  it('slugs a field-level label to a stable key', () => {
    expect(slugifyDomain('Health Data Science & Biostatistics')).toBe('health-data-science-and-biostatistics')
    expect(slugifyDomain('  Cardiology ')).toBe('cardiology')
  })

  it('never returns an empty key', () => {
    expect(slugifyDomain('')).toBe('domain')
    expect(slugifyDomain('!!!')).toBe('domain')
  })
})

describe('nextColor', () => {
  it('hands out the first unused palette color', () => {
    expect(nextColor([])).toBe(PALETTE[0])
    expect(nextColor([{ color: PALETTE[0] }, { color: PALETTE[1] }])).toBe(PALETTE[2])
  })

  it('cycles when the palette is exhausted', () => {
    const all = PALETTE.map((c) => ({ color: c }))
    expect(PALETTE).toContain(nextColor(all))
  })
})

describe('matchDomain', () => {
  // The user's hand-added fields — the classifier must land ON these, not beside them.
  const DOMAINS = [
    { key: 'vascular-surgery', label: 'Vascular Surgery' },
    { key: 'ai-ml', label: 'AI / ML', source: 'user' },
    { key: 'carotid-disease', label: 'Carotid Disease', source: 'user' },
  ]

  it('matches an existing key, slug or label', () => {
    expect(matchDomain('ai-ml', DOMAINS).key).toBe('ai-ml')
    expect(matchDomain('Carotid Disease', DOMAINS).key).toBe('carotid-disease')
    expect(matchDomain('carotid disease', DOMAINS).key).toBe('carotid-disease')
  })

  it("reuses the user's field however the model punctuates it", () => {
    for (const proposed of ['AI / ML', 'AI & ML', 'AI and ML', 'AI/ML']) {
      expect(matchDomain(proposed, DOMAINS)?.key).toBe('ai-ml')
    }
  })

  it('a genuinely new field stays new', () => {
    expect(matchDomain('Medical Education', DOMAINS)).toBeUndefined()
    expect(matchDomain('Carotid Stenting Technique', DOMAINS)).toBeUndefined()
  })

  it('does not collapse a narrow field into the specialty that contains it', () => {
    expect(matchDomain('Vascular Surgery', DOMAINS).key).toBe('vascular-surgery')
    expect(matchDomain('Limb', DOMAINS)).toBeUndefined()
  })

  it('tolerates empty input and an empty taxonomy', () => {
    expect(matchDomain('', DOMAINS)).toBeUndefined()
    expect(matchDomain(null, DOMAINS)).toBeUndefined()
    expect(matchDomain('AI / ML', [])).toBeUndefined()
    expect(matchDomain('AI / ML', undefined)).toBeUndefined()
  })
})

describe('normalizeDomainName', () => {
  it('folds punctuation, case and the word "and"', () => {
    expect(normalizeDomainName('AI & ML')).toBe(normalizeDomainName('ai/ml'))
    expect(normalizeDomainName('Health Data Science and Biostatistics')).toBe(
      normalizeDomainName('Health Data Science & Biostatistics'),
    )
  })

  it('keeps distinct fields distinct', () => {
    expect(normalizeDomainName('Limb')).not.toBe(normalizeDomainName('Limb Preservation'))
    expect(normalizeDomainName('')).toBe('')
  })
})

describe('unhydrated lookups (no IndexedDB in tests)', () => {
  it('legacy keys keep their original label and color', () => {
    expect(domainLabel('vascular')).toBe(LEGACY_DOMAINS[0].label)
    expect(domainColor('vascular')).toBe(LEGACY_DOMAINS[0].color)
  })

  it('unknown keys fall back honestly', () => {
    expect(domainLabel('nope')).toBe('Unclassified')
    expect(domainColor('nope')).toBe(DEFAULT_PAPER_COLOR)
  })
})
