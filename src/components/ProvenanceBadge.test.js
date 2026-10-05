import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ProvenanceBadge from './ProvenanceBadge.jsx'
import { badgeWord } from '../lib/badgeWord.js'
import { TIERS } from '../pipeline/verify.js'

describe('ProvenanceBadge — one word, detail on hover', () => {
  it('says Verified for every tier that matched, and never for one that did not', () => {
    for (const tier of [TIERS.REGISTRY, TIERS.FULL_TEXT, TIERS.ABSTRACT, TIERS.USER_TEXT, TIERS.ESTIMATE, TIERS.COMPARISON, TIERS.PROPORTION, TIERS.HETEROGENEITY]) {
      expect(badgeWord(tier)).toBe('Verified')
    }
    expect(badgeWord(TIERS.LOCATED)).toBe('Unresolved')
    expect(badgeWord(TIERS.FLAGGED)).toBe('Flagged')
    expect(badgeWord('legacy-unchecked')).toBe('Outdated')
    expect(badgeWord('something-new')).toBe('Flagged')
  })
  it('keeps what was and was not checked in the hover text', () => {
    const html = renderToStaticMarkup(React.createElement(ProvenanceBadge, { tier: TIERS.COMPARISON, sourceTier: 'abstract_only' }))
    expect(html).toContain('>Verified<')
    expect(html).toContain('title="Values verified as printed · abstract · groups unchecked"')
  })
})
