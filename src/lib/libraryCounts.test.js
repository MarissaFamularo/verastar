import { describe, expect, it } from 'vitest'
import { VERIFICATION_VERSION } from './evidenceVersion.js'
import { libraryRailCounts } from './libraryCounts.js'

const validated = {
  tier: 'verified-estimate',
  relationshipValidated: true,
  flagged: false,
  verificationVersion: VERIFICATION_VERSION,
}

describe('libraryRailCounts', () => {
  it('keeps a starter sample out of the saved and checked-number counts', () => {
    const counts = libraryRailCounts([
      { id: 'crest', title: 'CREST-2 and the modern management of carotid stenosis', saveSource: 'seed', savedAt: new Date().toISOString(), quantities: [{ verdict: validated }] },
      { id: 'mine', title: 'My note', saveSource: 'digest', savedAt: new Date().toISOString(), notes: 'because of the endpoint', quantities: [{ verdict: validated }], flagged: true },
    ])
    expect(counts).toMatchObject({ verified: 1, saved: 1, flagged: 1, starters: 1, starterTitle: 'CREST-2' })
    expect(counts.withoutWhy).toBe(0)
  })

  it('does not nudge a starter that has no why', () => {
    const counts = libraryRailCounts([
      { id: 'crest', title: 'CREST', saveSource: 'seed', savedAt: new Date().toISOString() },
    ])
    expect(counts).toMatchObject({ verified: 0, saved: 0, flagged: 0, withoutWhy: 0, starters: 1, starterTitle: 'CREST' })
  })
})
