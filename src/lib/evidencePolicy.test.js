import { describe, it, expect } from 'vitest'
import { evidenceVerdict, isRelationshipValidated, hasValidatedPaperEvidence, VERIFICATION_VERSION } from './evidenceVersion.js'

describe('read-time evidence version contract', () => {
  for (const verdict of [undefined, { tier: 'verified-full-text', flagged: false, found: true }, { tier: 'verified-registry', flagged: false, verificationVersion: 'old' }]) {
    it('withholds missing or old verdicts without mutating their original', () => {
      const snapshot = JSON.stringify(verdict)
      expect(evidenceVerdict(verdict).tier).toBe('legacy-unchecked')
      expect(isRelationshipValidated(verdict)).toBe(false)
      expect(JSON.stringify(verdict)).toBe(snapshot)
    })
  }
  it('preserves a current validated verdict and its source offsets', () => {
    const verdict = { verificationVersion: VERIFICATION_VERSION, relationshipValidated: true, flagged: false, tier: 'verified-full-text', matched: { index: 0, length: 10 } }
    expect(evidenceVerdict(verdict)).toBe(verdict)
    expect(isRelationshipValidated(verdict)).toBe(true)
  })
  it('never promotes a current unresolved verdict', () => {
    expect(isRelationshipValidated({ verificationVersion: VERIFICATION_VERSION, relationshipValidated: false, flagged: true, tier: 'source-located' })).toBe(false)
  })
})

it('legacy warnings without message text cannot break evidence display', () => {
  expect(evidenceVerdict({ warnings: [{ kind: 'old-warning' }] }).warnings[0].message).toBe('')
})

describe('library paper evidence counts', () => {
  const current = { verificationVersion: VERIFICATION_VERSION, relationshipValidated: true, flagged: false, tier: 'verified-full-text' }
  it('ignores citation flags, relevance tiers and legacy flattened quantities', () => {
    for (const paper of [undefined, { verified: true }, { tier: 1 }, { quantities: [{ tier: 'verified-full-text', value: 20 }] }, { quantities: [{ verdict: { ...current, verificationVersion: 'old' } }] }]) {
      expect(hasValidatedPaperEvidence(paper)).toBe(false)
    }
  })
  it('requires an unflagged currently validated relationship', () => {
    expect(hasValidatedPaperEvidence({ quantities: [{ verdict: current }] })).toBe(true)
    expect(hasValidatedPaperEvidence({ quantities: [{ verdict: { ...current, flagged: true } }] })).toBe(false)
    expect(hasValidatedPaperEvidence({ quantities: [{ verdict: { ...current, relationshipValidated: false } }] })).toBe(false)
  })
  it('counts a mixed paper once without promoting other old or unresolved papers', () => {
    const mixed = { quantities: [{ verdict: { ...current, verificationVersion: 'old' } }, { verdict: current }, { verdict: current }] }
    const papers = [mixed, { tier: 1 }, { quantities: [{ verdict: { ...current, relationshipValidated: false } }] }]
    expect(papers.filter(hasValidatedPaperEvidence)).toEqual([mixed])
    expect(hasValidatedPaperEvidence({ quantities: {} })).toBe(false)
    expect(hasValidatedPaperEvidence({ quantities: [null] })).toBe(false)
  })
})
