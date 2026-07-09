// libraryFormat.test.js — locks the flat-file vault's PURE formatters. These render the verified
// facts out to markdown the clinician owns, so the trust-critical bits are: slugs are stable and
// filesystem-safe, frontmatter is present, verified numbers ALWAYS carry their tier (the honest
// edge), the README never overclaims ("second brain"), and stale/degenerate input never throws.

import { describe, it, expect } from 'vitest'
import {
  sourceSlug,
  conceptSlug,
  sourceNoteMd,
  conceptNoteMd,
  digestMd,
  connectionsEntryMd,
  readmeMd,
} from './libraryFormat.js'

const paper = (over = {}) => ({
  id: '12345',
  pmid: '12345',
  title: 'Drug-Coated Balloons in Chronic Limb-Threatening Ischemia',
  citation: 'Smith J · JVS · 2025',
  tier: 'verified-full-text',
  finding: 'Drug-coated devices reduced reintervention.',
  relevance: 'Feeds the Limb Preservation Program.',
  quantities: [{ name: 'Amputation-free survival', value: 84, unit: '%', tier: 'verified-full-text' }],
  pdfUrl: null,
  domain: 'vascular',
  tags: ['clti', 'bypass'],
  savedAt: '2026-07-09T14:22:00.000Z',
  ...over,
})

describe('sourceSlug', () => {
  it('is a date prefix + kebab of ~6 title words with punctuation stripped', () => {
    expect(sourceSlug(paper())).toBe('2026-07-09_drug-coated-balloons-in-chronic-limb-threatening-ischemia')
  })

  it('falls back to pmid-<pmid> when the title is empty', () => {
    expect(sourceSlug(paper({ title: '' }))).toBe('2026-07-09_pmid-12345')
  })

  it('handles a missing savedAt without throwing', () => {
    expect(sourceSlug(paper({ savedAt: undefined }))).toMatch(/^undated_/)
  })
})

describe('conceptSlug', () => {
  it('kebabs the label', () => {
    expect(conceptSlug({ label: 'Endovascular Revascularization' })).toBe('endovascular-revascularization')
  })
})

describe('sourceNoteMd', () => {
  it('opens with YAML frontmatter carrying the metadata', () => {
    const md = sourceNoteMd(paper())
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('title: "Drug-Coated Balloons in Chronic Limb-Threatening Ischemia"')
    expect(md).toContain('pmid: 12345')
    expect(md).toContain('domain: "Vascular Surgery & Limb Preservation"') // domainLabel, not the raw key
    expect(md).toContain('tags: [clti, bypass]')
  })

  it('renders each verified quantity WITH its tier and a PubMed link', () => {
    const md = sourceNoteMd(paper())
    expect(md).toContain('Amputation-free survival:** 84 %')
    expect(md).toContain('tier: `verified-full-text`')
    expect(md).toContain('https://pubmed.ncbi.nlm.nih.gov/12345/')
  })

  it('links the open-access PDF only when pdfUrl is present', () => {
    expect(sourceNoteMd(paper({ pdfUrl: null }))).not.toContain('Open-access full text')
    const withPdf = sourceNoteMd(paper({ pdfUrl: 'https://host/x.pdf' }))
    expect(withPdf).toContain('[Open-access full text (PDF)](https://host/x.pdf)')
    expect(withPdf).toContain('pdf: "https://host/x.pdf"') // frontmatter carries the link (yaml-quoted)
  })

  it('does not throw on a bare record with no quantities/citation', () => {
    expect(() => sourceNoteMd({ pmid: '9', title: 'X', savedAt: '2026-01-01T00:00:00Z' })).not.toThrow()
  })
})

describe('conceptNoteMd', () => {
  it('carries the summary and lists filed sources with links', () => {
    const node = { label: 'CLTI Revascularization', domain: 'vascular', summary: 'The evidence converges.', tags: ['clti'], updatedAt: '2026-07-09T00:00:00Z' }
    const md = conceptNoteMd(node, [paper()])
    expect(md).toContain('topic: "CLTI Revascularization"')
    expect(md).toContain('sources: 1')
    expect(md).toContain('The evidence converges.')
    expect(md).toContain('https://pubmed.ncbi.nlm.nih.gov/12345/')
    expect(md).toContain('**Tags:** clti')
  })

  it('is safe with no member papers', () => {
    const md = conceptNoteMd({ label: 'Empty' }, [])
    expect(md).toContain('No sources filed')
  })
})

describe('digestMd', () => {
  it('renders a dated header and one section per entry', () => {
    const md = digestMd('2026-07-09', [
      { title: 'Paper A', citation: 'A et al · 2025', tier: 'abstract-only', finding: 'It worked.' },
    ])
    expect(md).toContain('# Digest — 2026-07-09')
    expect(md).toContain('## Paper A')
    expect(md).toContain('abstract-only')
    expect(md).toContain('It worked.')
  })

  it('does not throw on empty entries', () => {
    expect(() => digestMd('2026-07-09', [])).not.toThrow()
  })
})

describe('connectionsEntryMd', () => {
  const weekend = {
    opener: 'A limb-preservation thread emerged.',
    threads: [
      { anchor: 'Limb Preservation Program', pmids: ['111', '999'], narrative: 'They converge on durability.' },
    ],
    gaps: ['Nothing touched carotid.'],
  }
  const lookup = { 111: { title: 'BASIL-3', citation: 'Bradbury · Lancet · 2023' } }

  it('resolves known pmids via the lookup and drops unknown ones', () => {
    const md = connectionsEntryMd('2026-07-09', weekend, lookup)
    expect(md).toContain('## Week of 2026-07-09')
    expect(md).toContain('### Limb Preservation Program')
    expect(md).toContain('BASIL-3')
    expect(md).toContain('https://pubmed.ncbi.nlm.nih.gov/111/')
    expect(md).not.toContain('/999/') // unknown pmid dropped gracefully
    expect(md).toContain('### Gaps')
    expect(md).toContain('Nothing touched carotid.')
  })

  it('accepts a Map lookup and survives empty input', () => {
    const md = connectionsEntryMd('2026-07-09', weekend, new Map([['111', lookup['111']]]))
    expect(md).toContain('BASIL-3')
    expect(() => connectionsEntryMd('2026-07-09', {}, {})).not.toThrow()
  })
})

describe('readmeMd', () => {
  it('shows live counts and does NOT contain "second brain"', () => {
    const md = readmeMd({ profileName: 'Dr. Famularo', counts: { sources: 12, concepts: 4 } })
    expect(md).toContain("Dr. Famularo's evidence library")
    expect(md).toContain('**12** sources')
    expect(md).toContain('**4** concepts')
    expect(md.toLowerCase()).not.toContain('second brain')
  })

  it('defaults counts to zero without throwing', () => {
    expect(() => readmeMd({})).not.toThrow()
    expect(readmeMd({})).toContain('**0** sources')
  })
})
