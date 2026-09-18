import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DigestRail } from '../App.jsx'
import { DEMO_DIGEST, DEMO_DIGEST_COUNTS } from './demoDigest.js'

describe('read-only demo digest', () => {
  it('ships as a populated set of public PubMed records', () => {
    expect(DEMO_DIGEST.results).toHaveLength(5)
    expect(DEMO_DIGEST_COUNTS).toEqual({ verified: 0, saved: 0, flagged: 0 })

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


it('renders zero validated-evidence papers in the sample rail without a verification claim', () => {
  const html = renderToStaticMarkup(React.createElement(DigestRail, { counts: DEMO_DIGEST_COUNTS, projects: [], trellis: [], demo: true }))
  expect(html).toContain('In this sample')
  expect(html).toContain('with checked numbers')
  expect(html).toMatch(/>0<\/div>.*?with checked numbers/)
  expect(html).not.toContain('>verified<')
})

it('labels the real all-time counts as the library rather than this week', () => {
  const html = renderToStaticMarkup(React.createElement(DigestRail, { counts: { verified: 1, saved: 4, flagged: 0 }, projects: [], trellis: [], demo: false }))
  expect(html).toContain('Your library')
  expect(html).not.toContain('This week')
  expect(html).toContain('with checked numbers')
})
