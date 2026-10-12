import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DigestRail } from '../App.jsx'
import SpineCheck from '../components/SpineCheck.jsx'
import { isRelationshipValidated } from '../lib/evidenceVersion.js'
import { verify } from '../pipeline/verify.js'
import { DEMO_DIGEST, DEMO_DIGEST_COUNTS } from './demoDigest.js'
import specs from './checkedExamplePassages.json'

const BANNED = ['36342173', '37116524', 'BEST-CLI', 'BASIL-2']

describe('read-only demo digest', () => {
  it('ships as a populated set of public PubMed records', () => {
    expect(DEMO_DIGEST.results.filter((result) => result.rows.length === 0)).toHaveLength(5)
    expect(DEMO_DIGEST_COUNTS).toEqual({ verified: 2, saved: 0, flagged: 0 })

    for (const result of DEMO_DIGEST.results) {
      expect(result.citation.url).toBe(`https://pubmed.ncbi.nlm.nih.gov/${result.paper.pmid}/`)
      expect(result.citation.verified).toBe(true)
      expect(DEMO_DIGEST.triaged[result.paper.id]?.finding).toBeTruthy()
    }
  })

  it('checks a few rows against stored fixture text instead of stamping them verified', () => {
    const serialized = JSON.stringify(DEMO_DIGEST)
    for (const banned of BANNED) expect(serialized).not.toContain(banned)

    const checked = DEMO_DIGEST.results.filter((result) => result.rows.length > 0)
    expect(checked.map((result) => result.paper.pmid)).toEqual(['20505173', '41269206'])
    expect(checked.reduce((n, result) => n + result.rows.length, 0)).toBe(5)

    for (const spec of specs) {
      const fixture = JSON.parse(readFileSync(`src/pipeline/__fixtures__/devset/${spec.fixture}`, 'utf8'))
      const result = checked.find((item) => item.paper.pmid === spec.pmid)
      expect(result.source.tier).toBe('full_text')
      expect(result.sourceDoc.text.length).toBeGreaterThan(spec.quantities[0].source_quote.length)
      for (const passage of spec.passages) {
        expect(fixture.sourceDoc.text.includes(passage)).toBe(true)
        expect(passage.length).toBeGreaterThan(80)
      }
      expect(result.rows).toHaveLength(spec.quantities.length)
      for (const row of result.rows) {
        const fixtureRow = fixture.rows.find((item) => item.quantity.source_quote === row.quantity.source_quote)
        expect(fixtureRow).toBeTruthy()
        expect(row.quantity).toEqual(fixtureRow.quantity)
        expect(fixture.sourceDoc.text.includes(row.quantity.source_quote)).toBe(true)
        expect(result.sourceDoc.text.includes(row.quantity.source_quote)).toBe(true)
        const fromFixture = verify(row.quantity, fixture.sourceDoc, { sourceTier: 'full_text' })
        const fromPassage = verify(row.quantity, result.sourceDoc, { sourceTier: 'full_text' })
        expect(isRelationshipValidated(fromFixture)).toBe(true)
        expect(row.verdict).toEqual(fromPassage)
        expect(row.verdict.relationshipStatus).toBe(fromFixture.relationshipStatus)
        expect(row.verdict.flagged).toBe(false)
        expect(row.verdict.verificationVersion).toBe(fromFixture.verificationVersion)
      }
    }
  })

  it('contains no user-library or personal-profile fields', () => {
    const serialized = JSON.stringify(DEMO_DIGEST)
    for (const field of ['favorite', 'savedAt', 'projects', 'northStars', 'profile', 'notes']) {
      expect(serialized).not.toContain(`"${field}"`)
    }
  })
})


it('counts the sample papers whose stored text the verifier accepted', () => {
  const html = renderToStaticMarkup(React.createElement(DigestRail, { counts: DEMO_DIGEST_COUNTS, projects: [], trellis: [], demo: true }))
  expect(html).toContain('In this sample')
  expect(html).toContain('with checked numbers')
  expect(html).toMatch(/>2<\/div>.*?with checked numbers/)
  expect(html).not.toContain('>verified<')
})

it('shows those checked numbers on the sample cards and leaves the metadata-only papers unchecked', () => {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
  globalThis.sessionStorage = storage
  globalThis.localStorage = storage
  const html = renderToStaticMarkup(React.createElement(SpineCheck, { demo: true }))
  expect(html).toContain('3 numbers checked against the source · full text')
  expect(html).toContain('2 numbers checked against the source · full text')
  expect(html).toContain('See the checked numbers (3)')
  expect(html).toContain('No checked numbers')
  expect(html).not.toContain('BEST-CLI')
})

it('labels the real all-time counts as the library rather than this week', () => {
  const html = renderToStaticMarkup(React.createElement(DigestRail, { counts: { verified: 1, saved: 4, flagged: 0 }, projects: [], trellis: [], demo: false }))
  expect(html).toContain('Your library')
  expect(html).not.toContain('This week')
  expect(html).toContain('with checked numbers')
})

it('names a starter sample without counting it as a saved paper', () => {
  const html = renderToStaticMarkup(React.createElement(DigestRail, {
    counts: { verified: 0, saved: 0, flagged: 0, withoutWhy: 0, starters: 1, starterTitle: 'CREST' },
    projects: [],
    trellis: [],
    demo: false,
  }))
  expect(html).toContain('1 starter sample')
  expect(html).toContain('CREST')
  expect(html).toContain('not counted above')
  expect(html).toMatch(/>0<\/div>.*?saved/)
})
