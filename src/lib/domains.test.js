// lib/domains.test.js — pure logic of the per-user domain registry: slugging a proposed
// label to a stable key, and palette assignment for newly minted domains. (Store-backed
// behavior — loadDomains migration, ensureDomain — needs IndexedDB and is exercised live.)

import { describe, it, expect } from 'vitest'
import { slugifyDomain, nextColor, PALETTE, LEGACY_DOMAINS, domainLabel, domainColor, DEFAULT_PAPER_COLOR } from './domains.js'

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
