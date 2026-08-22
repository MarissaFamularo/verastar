import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CURRENT_EXTRACTION_VERSION } from '../lib/evidenceVersion.js'
import { PaperRow, SavedDigestDetails } from './KnowledgeBase.jsx'

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
    expect(html).toContain('Checked summary:')
    expect(html).toContain('The intervention improved the primary outcome.')
    expect(html).toContain('Why it connects to your work:')
    expect(html).toContain('The observational design cannot establish causality.')
    expect(html).toContain('VERIFIED VALUES')
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
    expect(html).toContain('Uses your Claude key')
    expect(disabled).toContain('disabled=""')
    expect(disabled).toContain('Set your API key in Settings')
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
