import { describe, expect, it } from 'vitest'
import { DEMO_DIGEST, DEMO_DIGEST_COUNTS } from './demoDigest.js'

describe('read-only demo digest', () => {
  it('ships as a populated set of public PubMed records', () => {
    expect(DEMO_DIGEST.results).toHaveLength(5)
    expect(DEMO_DIGEST_COUNTS).toEqual({ verified: 5, saved: 0, flagged: 0 })

    for (const result of DEMO_DIGEST.results) {
      expect(result.citation.url).toBe(`https://pubmed.ncbi.nlm.nih.gov/${result.paper.pmid}/`)
      expect(result.citation.verified).toBe(true)
      expect(DEMO_DIGEST.triaged[result.paper.id]?.finding).toBeTruthy()
    }
  })

  it('contains no user-library or personal-profile fields', () => {
    const serialized = JSON.stringify(DEMO_DIGEST)
    for (const field of ['favorite', 'savedAt', 'projects', 'northStars', 'profile', 'notes']) {
      expect(serialized).not.toContain(`"${field}"`)
    }
  })
})
