import { describe, expect, it } from 'vitest'
import { buildPaperRecord } from './save.js'
import { CURRENT_EXTRACTION_VERSION } from '../lib/evidenceVersion.js'

describe('buildPaperRecord — design appraisal survives a manual or digest save', () => {
  it('persists design caution separately from the finding and verified facts', () => {
    const res = {
      paper: { id: '42335023', pmid: '42335023' },
      citation: { title: 'National comparative analysis' },
      design: 'retrospective_cohort',
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      source: { pmcid: null },
      sourceDoc: { text: 'Registry source', tables: '' },
      rows: [],
    }
    const take = {
      score: 88,
      tier: 2,
      finding: 'Perfusion technologies were associated with favorable outcomes.',
      designCaution: 'The accepted-recipient observational design cannot establish a universal standard of care.',
      relevance: 'Relevant to machine perfusion adoption.',
      check: { verdict: 'supported', reason: '' },
      cautionCheck: { verdict: 'supported', reason: '' },
    }

    const paper = buildPaperRecord(res, take, { source: 'manual' })

    expect(paper.design).toBe('retrospective_cohort')
    expect(paper.extractionVersion).toBe(CURRENT_EXTRACTION_VERSION)
    expect(paper.designCaution).toBe(take.designCaution)
    expect(paper.cautionCheck).toEqual({ verdict: 'supported', reason: '' })
    expect(paper.finding).toBe(take.finding)
    expect(paper.score).toBe(88)
    expect(paper.relevance).toBe(take.relevance)
    expect(paper.saveSource).toBe('manual')
  })

  it('keeps an older or missing run stamp instead of falsely upgrading it at save time', () => {
    const base = { paper: { id: '1', pmid: '1' }, citation: {}, source: {}, sourceDoc: {}, rows: [] }
    expect(buildPaperRecord(base, {}).extractionVersion).toBe(null)
    expect(buildPaperRecord({ ...base, extractionVersion: '2026-07-01.v1' }, {}).extractionVersion).toBe('2026-07-01.v1')
  })

  it('persists only verified rows for the expandable evidence list', () => {
    const res = {
      paper: { id: '1', pmid: '1' }, citation: {}, source: {}, sourceDoc: {},
      rows: [
        { quantity: { name: 'Probability', range_low: 0.823, range_high: 0.855 }, verdict: { flagged: false, tier: 'verified-abstract' } },
        { quantity: { name: 'Unsupported', value: 9 }, verdict: { flagged: true, tier: 'flagged' } },
      ],
    }
    const paper = buildPaperRecord(res, { score: 58 })
    expect(paper.quantities).toEqual([{
      name: 'Probability', range_low: 0.823, range_high: 0.855, tier: 'verified-abstract',
    }])
    expect(paper.score).toBe(58)
  })
})

describe('mergeRefreshedEvidence — a re-save or refresh never destroys curation', () => {
  it('replaces the evidence channel while keeping user- and foreign-owned fields', async () => {
    const { mergeRefreshedEvidence } = await import('./save.js')
    const existing = {
      id: '1', pmid: '1', title: 'Old title',
      tags: ['aorta'], notes: 'my note', favorite: true, conceptId: 'c1',
      domain: 'vascular', savedAt: '2026-08-01T00:00:00.000Z', saveSource: 'papertrellis',
      vaultWrittenAt: '2026-08-02T00:00:00.000Z',
      trellisProjects: [{ id: 'proj-1', title: 'CLTI Outcomes', addedAt: '2026-08-01T00:00:00.000Z' }],
      finding: '', quantities: [],
    }
    const base = { paper: { id: '1', pmid: '1' }, citation: { title: 'New title' }, source: {}, sourceDoc: { text: 'body' }, rows: [] }
    const fresh = buildPaperRecord(base, { finding: 'New finding', score: 70 }, { source: 'digest' })

    const next = mergeRefreshedEvidence(existing, fresh, '2026-08-22T05:00:00.000Z')

    expect(next.finding).toBe('New finding')
    expect(next.score).toBe(70)
    expect(next.evidenceRefreshedAt).toBe('2026-08-22T05:00:00.000Z')
    // curation and provenance survive
    expect(next.tags).toEqual(['aorta'])
    expect(next.notes).toBe('my note')
    expect(next.favorite).toBe(true)
    expect(next.conceptId).toBe('c1')
    expect(next.domain).toBe('vascular')
    expect(next.savedAt).toBe('2026-08-01T00:00:00.000Z')
    expect(next.saveSource).toBe('papertrellis')
    expect(next.trellisProjects).toEqual(existing.trellisProjects)
  })
})
