import { describe, expect, it, vi } from 'vitest'
import { CURRENT_EXTRACTION_VERSION } from '../lib/evidenceVersion.js'
import { mergeRefreshedEvidence, needsDigestDetails, refreshSavedPaperEvidence } from './refreshEvidence.js'

function savedPaper(overrides = {}) {
  return {
    id: '123',
    pmid: '123',
    title: 'Saved title',
    extractionVersion: null,
    finding: '',
    quantities: [],
    notes: 'Keep my note',
    tags: ['clti'],
    favorite: true,
    conceptId: 'concept-1',
    domain: 'vascular',
    memoIds: ['memo-1'],
    savedAt: '2026-07-01T00:00:00.000Z',
    saveSource: 'digest',
    ...overrides,
  }
}

function successfulResult() {
  return {
    paper: { id: '123', pmid: '123', title: 'Fresh title' },
    citation: { title: 'Fresh title', url: 'https://pubmed.ncbi.nlm.nih.gov/123/' },
    design: 'cohort',
    extractionVersion: CURRENT_EXTRACTION_VERSION,
    source: { tier: 'abstract_only', pmcid: null },
    sourceDoc: { text: 'RESULTS: The outcome occurred in 5.5%.', tables: '' },
    rows: [{
      quantity: { name: 'Outcome', value: 5.5, unit: '%', source_quote: 'The outcome occurred in 5.5%.' },
      verdict: { flagged: false, tier: 'verified-abstract' },
    }],
  }
}

describe('one-paper digest detail eligibility', () => {
  it('offers refresh only for a missing summary or incomplete legacy evidence', () => {
    expect(needsDigestDetails(savedPaper())).toBe(true)
    expect(needsDigestDetails(savedPaper({ finding: 'Old summary.' }))).toBe(true)
    expect(needsDigestDetails(savedPaper({ extractionVersion: CURRENT_EXTRACTION_VERSION, finding: 'Current summary.' }))).toBe(false)
    expect(needsDigestDetails(savedPaper({ extractionVersion: CURRENT_EXTRACTION_VERSION, finding: 'A review with no numeric claims.', quantities: [] }))).toBe(false)
    expect(needsDigestDetails(savedPaper({ retracted: true }))).toBe(false)
  })
})

describe('refreshed evidence merge', () => {
  it('replaces evidence while preserving clinician-owned Library metadata', () => {
    const existing = savedPaper()
    const fresh = {
      id: '123', pmid: '123', title: 'Fresh title', citation: { title: 'Fresh title' },
      design: 'cohort', extractionVersion: CURRENT_EXTRACTION_VERSION, score: 81, tier: 2,
      finding: 'Fresh checked summary.', designCaution: 'Association is not causation.',
      relevance: 'Connects to the active project.', check: { verdict: 'supported', reason: '' },
      cautionCheck: { verdict: 'supported', reason: '' }, quantities: [{ name: 'Outcome', value: 5.5 }],
      fullText: 'Fresh source', tables: '', pdfUrl: null, oaUrl: null,
    }
    const next = mergeRefreshedEvidence(existing, fresh, '2026-08-13T21:00:00.000Z')

    expect(next).toMatchObject({
      title: 'Fresh title', finding: 'Fresh checked summary.', extractionVersion: CURRENT_EXTRACTION_VERSION,
      notes: 'Keep my note', tags: ['clti'], favorite: true, conceptId: 'concept-1', domain: 'vascular',
      memoIds: ['memo-1'], savedAt: '2026-07-01T00:00:00.000Z', saveSource: 'digest',
      evidenceRefreshedAt: '2026-08-13T21:00:00.000Z',
    })
  })
})

describe('atomic one-paper refresh', () => {
  it('does not write anything when the paid paper run fails', async () => {
    const putPaper = vi.fn()

    await expect(refreshSavedPaperEvidence(savedPaper(), {
      services: {
        runPaper: vi.fn().mockResolvedValue({ error: 'source unavailable' }),
        putPaper,
      },
    })).rejects.toThrow('source unavailable')

    expect(putPaper).not.toHaveBeenCalled()
  })

  it('writes once after extraction and summary succeed, preserving edits made during the run', async () => {
    const stages = []
    const putPaper = vi.fn().mockResolvedValue(undefined)
    const current = savedPaper({ notes: 'Edited while Claude was running' })
    const runPaper = vi.fn().mockImplementation(async (_paper, { onStage }) => {
      onStage('123', 'fetching')
      onStage('123', 'extracting')
      onStage('123', 'verifying')
      return successfulResult()
    })

    const next = await refreshSavedPaperEvidence(savedPaper(), {
      onStage: (stage) => stages.push(stage),
      services: {
        runPaper,
        triage: vi.fn().mockResolvedValue([{
          id: '123', score: 82, tier: 2, finding: 'The outcome occurred in 5.5%.',
          designCaution: 'The cohort design cannot establish causality.',
          relevance: 'It informs the active project.',
          check: { verdict: 'supported', reason: '' }, cautionCheck: { verdict: 'supported', reason: '' },
        }]),
        getProfile: vi.fn().mockResolvedValue({ northStars: [], projects: [], rubric: { criteria: '' } }),
        getPaper: vi.fn().mockResolvedValue(current),
        putPaper,
        depositPaper: vi.fn().mockResolvedValue(undefined),
        logEvent: vi.fn(),
      },
    })

    expect(putPaper).toHaveBeenCalledTimes(1)
    expect(putPaper).toHaveBeenCalledWith('123', next)
    expect(next.notes).toBe('Edited while Claude was running')
    expect(next.finding).toBe('The outcome occurred in 5.5%.')
    expect(next.quantities).toHaveLength(1)
    expect(stages).toEqual(['fetching', 'extracting', 'verifying', 'summarizing', 'saving', 'done'])
  })
})
