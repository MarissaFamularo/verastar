import { describe, it, expect } from 'vitest'
import { evidenceVerdict, isRelationshipValidated, VERIFICATION_VERSION } from './evidenceVersion.js'

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
