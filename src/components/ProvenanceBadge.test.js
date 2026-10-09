import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ProvenanceBadge from './ProvenanceBadge.jsx'
import { badgeWord, badgeExplanation } from '../lib/badgeWord.js'
import { TIERS } from '../pipeline/verify.js'

describe('ProvenanceBadge — one word, detail on hover and tap', () => {
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
  it('is one keyboard- and tap-reachable button, closed by default', () => {
    const html = renderToStaticMarkup(React.createElement(ProvenanceBadge, { tier: TIERS.ESTIMATE, sourceTier: 'full_text' }))
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Not checked')
  })
  it('opened, it spells out what was and was not checked without nesting controls', () => {
    const html = renderToStaticMarkup(React.createElement(ProvenanceBadge, { tier: TIERS.COMPARISON, sourceTier: 'abstract_only', initialOpen: true }))
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('role="note"')
    expect(html).toContain('Groups and endpoint: which arm or cohort each value belongs to, and which outcome.')
    expect(html).toContain('the abstract (full text was not available)')
    // The panel is a sibling of the button, never inside it.
    expect(html.indexOf('</button>')).toBeLessThan(html.indexOf('role="note"'))
    expect(html.match(/<button/g)).toHaveLength(1)
  })
})

describe('badgeExplanation', () => {
  it('every verified subtype names an unchecked dimension and the arm/population/outcome/timepoint reminder', () => {
    for (const tier of [TIERS.REGISTRY, TIERS.FULL_TEXT, TIERS.ABSTRACT, TIERS.USER_TEXT, TIERS.ESTIMATE, TIERS.COMPARISON, TIERS.PROPORTION, TIERS.HETEROGENEITY]) {
      const e = badgeExplanation(tier, 'full_text')
      expect(e.checked.length).toBeGreaterThan(0)
      expect(e.unchecked.join(' ')).toMatch(/arm, population, outcome and timepoint/)
    }
    expect(badgeExplanation(TIERS.ESTIMATE).unchecked[0]).toMatch(/^Endpoint/)
    expect(badgeExplanation(TIERS.PROPORTION).unchecked[0]).toMatch(/^Endpoint/)
    expect(badgeExplanation(TIERS.HETEROGENEITY).unchecked[0]).toMatch(/^Analysis/)
    expect(badgeExplanation(TIERS.COMPARISON).unchecked[0]).toMatch(/^Groups and endpoint/)
  })
  it('a flagged or unknown value claims nothing was checked', () => {
    expect(badgeExplanation(TIERS.FLAGGED).checked).toEqual([])
    expect(badgeExplanation('something-new').checked).toEqual([])
  })
})
