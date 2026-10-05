import { verify } from '../pipeline/verify.js'
import { currentPaperQuantities, isRelationshipValidated } from '../lib/evidenceVersion.js'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CURRENT_EXTRACTION_VERSION } from '../lib/evidenceVersion.js'
import { PaperRow, SavedDigestDetails } from './KnowledgeBase.jsx'
import RetractionNotice from './RetractionNotice.jsx'

const handlers = {
  onRemoveTag: () => {},
  onSaveNote: () => {},
  onDelete: () => {},
  onToggleFavorite: () => {},
}

function paper(overrides = {}) {
  return {
    id: '42560069',
    pmid: '42560069',
    title: 'A saved paper',
    citation: {
      author: 'Morgan et al.',
      journal: 'Journal of Testing',
      year: '2026',
      url: 'https://pubmed.ncbi.nlm.nih.gov/42560069/',
    },
    extractionVersion: CURRENT_EXTRACTION_VERSION,
    finding: 'The intervention improved the primary outcome.',
    relevance: 'It directly informs the active limb-preservation project.',
    designCaution: 'The observational design cannot establish causality.',
    check: { verdict: 'supported', reason: '' },
    cautionCheck: { verdict: 'supported', reason: '' },
    quantities: [{ name: 'Primary outcome', value: 5.5, unit: '%', source_quote: 'The primary outcome occurred in 5.5%.' }],
    pdfUrl: 'https://example.org/paper.pdf',
    tags: [],
    notes: '',
    ...overrides,
  }
}

describe('Library paper digest disclosure', () => {
  it('replaces fragmented controls with one collapsed digest-details caret', () => {
    const html = renderToStaticMarkup(React.createElement(PaperRow, { paper: paper(), ...handlers }))

    expect(html).toContain('▸ Digest details')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('>Summary<')
    expect(html).not.toContain('verified value')
    expect(html).not.toContain('View article')
  })

  it('renders the complete saved digest snapshot together', () => {
    const html = renderToStaticMarkup(React.createElement(SavedDigestDetails, { paper: paper() }))

    expect(html).toContain('SAVED DIGEST DETAILS')
    expect(html).toContain('>Summary:<')
    expect(html).toContain('The intervention improved the primary outcome.')
    expect(html).toContain('Why it connects to your work:')
    expect(html).toContain('The observational design cannot establish causality.')
    expect(html).toContain('VERIFIED')
    expect(html).toContain('The primary outcome occurred in 5.5%.')
    expect(html).toContain('View article')
    expect(html).toContain('https://example.org/paper.pdf')
  })

  it('states exactly what a legacy paper is missing without implying a new extraction', () => {
    const html = renderToStaticMarkup(React.createElement(SavedDigestDetails, {
      paper: paper({
        extractionVersion: null,
        finding: '',
        relevance: '',
        designCaution: '',
        quantities: [],
        pdfUrl: null,
      }),
    }))

    expect(html).toContain('No verified values were saved with this legacy extraction.')
    expect(html).toContain('No summary or connection to your work was saved with this paper.')
    expect(html).toContain('View article')
  })

  it('offers a paid create-details action only on an incomplete paper', () => {
    const incomplete = paper({ extractionVersion: null, finding: '', quantities: [] })
    const html = renderToStaticMarkup(React.createElement(PaperRow, {
      paper: incomplete,
      ...handlers,
      onCreateDetails: () => {},
      canCreateDetails: true,
    }))
    const disabled = renderToStaticMarkup(React.createElement(PaperRow, {
      paper: incomplete,
      ...handlers,
      onCreateDetails: () => {},
      canCreateDetails: false,
    }))

    expect(html).toContain('✦ Create digest details')
    expect(html).toContain('Re-reads and verifies this paper')
    expect(disabled).toContain('disabled=""')
    expect(disabled).toContain('set your API key in Settings')
  })
})

describe('PaperTrellis provenance', () => {
  it('shows the source pill and links each PaperTrellis project using the paper', () => {
    const html = renderToStaticMarkup(React.createElement(PaperRow, {
      paper: paper({
        saveSource: 'papertrellis',
        trellisProjects: [
          { id: 'proj-1', title: 'CLTI Outcomes', addedAt: '2026-08-22T05:00:00.000Z' },
          { id: 'proj-2', title: 'Carotid Review', addedAt: '2026-08-22T05:00:00.000Z' },
        ],
      }),
      ...handlers,
    }))

    expect(html).toContain('From PaperTrellis')
    expect(html).toContain('Used in PaperTrellis:')
    expect(html).toContain('CLTI Outcomes')
    expect(html).toContain('Carotid Review')
    expect(html).toContain('/projects/proj-1/literature')
  })

  it('renders nothing extra for papers without provenance', () => {
    const html = renderToStaticMarkup(React.createElement(PaperRow, { paper: paper(), ...handlers }))
    expect(html).not.toContain('Used in PaperTrellis:')
    expect(html).not.toContain('From PaperTrellis')
  })
})

describe('RetractionNotice', () => {
  it('renders nothing without alerts', () => {
    expect(renderToStaticMarkup(React.createElement(RetractionNotice, { alerts: [] }))).toBe('')
  })

  it('names each retracted saved paper with keep and review actions', () => {
    const html = renderToStaticMarkup(React.createElement(RetractionNotice, { alerts: [paper({ retracted: true })] }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('A saved paper')
    expect(html).toContain('Keep with warning')
    expect(html).toContain('Review in Library')
    expect(html).toContain('https://pubmed.ncbi.nlm.nih.gov/42560069/')
  })
})

describe('saved quantity rendering policy', () => {
  it('withholds an old swapped claim but keeps its exact saved source available', () => {
    const quantity = { name: 'Mortality', quantity_type: 'comparison', first_label: 'Treatment A', first_value: 20, second_label: 'Treatment B', second_value: 10, unit: '%', source_quote: 'Mortality was 10% in Treatment A and 20% in Treatment B.', tier: 'verified-full-text' }
    const html = renderToStaticMarkup(React.createElement(SavedDigestDetails, { paper: paper({ quantities: [quantity] }) }))
    expect(html).toContain('Claim withheld')
    expect(html).toContain('Mortality was 10% in Treatment A and 20% in Treatment B.')
    expect(html).not.toContain('Treatment A: 20')
    expect(html).toContain('0 VALUES VERIFIED')
  })
  it('renders a current correctly bound claim through the same saved surface', () => {
    const quantity = { name: 'Mortality', value: 10, unit: '%', source_quote: 'Mortality was 10%.' }
    quantity.verdict = verify(quantity, quantity.source_quote)
    const html = renderToStaticMarkup(React.createElement(SavedDigestDetails, { paper: paper({ quantities: [quantity] }) }))
    expect(html).toContain('1 VALUE VERIFIED')
    expect(html).toContain('10%')
    expect(html).not.toContain('Claim withheld')
  })
})

describe('Library summary links each verified number to its quote', () => {
  const SRC = 'Results. The hazard ratio was 0.84 (95% CI 0.61-1.16). Conclusion.'
  const q = { name: 'Hazard ratio', quantity_type: 'single', value: 0.84, ci_low: 0.61, ci_high: 1.16, source_quote: 'hazard ratio was 0.84 (95% CI 0.61-1.16)' }
  const withVerdict = { ...q, verdict: verify(q, SRC, { sourceTier: 'abstract_only' }) }
  const saved = (extra) => paper({ finding: 'Mortality fell (HR 0.84, CI 0.61–1.16).', quantities: [withVerdict], ...extra })

  it('makes each verified number in the summary, and each quote, open the source', () => {
    expect(withVerdict.verdict.relationshipValidated).toBe(true)
    const html = renderToStaticMarkup(React.createElement(SavedDigestDetails, { paper: saved({ fullText: SRC }) }))
    expect(html.match(/Matched to the source by the app/g)).toHaveLength(3)
    expect(html).toContain('see in source')
  })
  it('falls back to plain text when no source text was saved', () => {
    const html = renderToStaticMarkup(React.createElement(SavedDigestDetails, { paper: saved({ fullText: '', tables: '' }) }))
    expect(html).not.toContain('see in source')
    expect(html).not.toContain('Matched to the source by the app')
  })
})

describe('Library evidence is re-checked under the current verifier', () => {
  const SRC = 'Successful lesion crossing was achieved in 109 of 117 CTOs (93.2%). Technical success was similar for RA + DCB (94.3%) and DCB alone (94.6%).'
  // The exact rows saved for PMID 42829536 under estimates-v3, bookkeeping fields included.
  const stale = (q) => ({ ...q, tier: 'source-located', verdict: { tier: 'source-located', flagged: true, relationshipValidated: false, relationshipStatus: 'unresolved', sourceTier: 'abstract_only', verificationVersion: '2026-09-30.estimates-v3', reason: 'Quote and numeric tokens located; relationships remain unresolved.' } })
  const crossing = stale({ name: 'Successful lesion crossing', quantity_type: 'single', unit: '%', value: 93.2, ci_low: null, ci_high: null, p_value: null, range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, source_quote: 'Successful lesion crossing was achieved in 109 of 117 CTOs (93.2%).', location_hint: 'Abstract, Results' })
  const technical = stale({ name: 'Technical success', quantity_type: 'comparison', unit: '%', value: null, ci_low: null, ci_high: null, p_value: null, range_low: null, range_high: null, first_label: 'RA + DCB', first_value: 94.3, second_label: 'DCB alone', second_value: 94.6, source_quote: 'Technical success was similar for RA + DCB (94.3%) and DCB alone (94.6%).', location_hint: 'Abstract, Results' })

  it('upgrades stale verdicts from the saved source text', () => {
    const out = currentPaperQuantities({ quantities: [crossing, technical], fullText: SRC })
    expect(out.map((q) => q.verdict.tier)).toEqual(['verified-proportion', 'verified-comparison'])
    expect(out.every((q) => isRelationshipValidated(q.verdict))).toBe(true)
  })
  it('leaves verdicts alone when no source text was saved', () => {
    expect(currentPaperQuantities({ quantities: [crossing] })[0]).toBe(crossing)
  })
  it('leads with the numbers the summary uses and folds the rest', () => {
    const html = renderToStaticMarkup(React.createElement(SavedDigestDetails, {
      paper: paper({ finding: 'Crossing succeeded in most lesions (93.2%).', quantities: [crossing, technical], fullText: SRC }),
    }))
    expect(html).toContain('1 NUMBER IN THE SUMMARY, VERIFIED')
    expect(html).toContain('1 more value from the paper')
    expect(html).not.toContain('Technical success:')
  })
  it('renders the upgraded values in the saved details', () => {
    const html = renderToStaticMarkup(React.createElement(SavedDigestDetails, { paper: paper({ quantities: [crossing, technical], fullText: SRC }) }))
    expect(html).toContain('2 VALUES VERIFIED')
    expect(html).toContain('93.2%')
  })
})
