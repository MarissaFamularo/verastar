import { verify } from './verify.js'
import { sourceNoteMd } from '../lib/libraryFormat.js'
import { describe, expect, it } from 'vitest'
import { buildPaperRecord, savedWithoutWhy } from './save.js'
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

  it('preserves every evidence row while preventing legacy tier promotion', () => {
    const res = {
      paper: { id: '1', pmid: '1' }, citation: {}, source: {}, sourceDoc: {},
      rows: [
        { quantity: { name: 'Probability', range_low: 0.823, range_high: 0.855 }, verdict: { flagged: false, tier: 'verified-abstract' } },
        { quantity: { name: 'Unsupported', value: 9 }, verdict: { flagged: true, tier: 'flagged' } },
      ],
    }
    const paper = buildPaperRecord(res, { score: 58 })
    expect(paper.quantities).toHaveLength(2)
    expect(paper.quantities[0]).toMatchObject({ name: 'Probability', range_low: 0.823, range_high: 0.855, tier: 'legacy-unchecked' })
    expect(paper.quantities[0].verdict).toMatchObject({ flagged: true, relationshipValidated: false, originalTier: 'verified-abstract' })
    expect(paper.quantities[1].value).toBe(9)
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

// ── the "why" capture (2026-09-05): notes passthrough + the Today rail's nudge count ──

const res = { paper: { id: 'p1', pmid: '12345678', title: 'A trial' }, citation: { doi: '10.1/x' }, rows: [], source: {} }

describe('buildPaperRecord notes', () => {
  it('seeds notes empty when no why was given', () => {
    expect(buildPaperRecord(res, {}, { title: 'A trial' }).notes).toBe('')
  })
  it('keeps the trimmed why when one was given', () => {
    expect(buildPaperRecord(res, {}, { title: 'A trial', notes: '  fits the CLTI chapter  ' }).notes).toBe('fits the CLTI chapter')
  })
})

describe('savedWithoutWhy', () => {
  const now = Date.parse('2026-09-05T12:00:00Z')
  const day = 86400000
  it('counts recent saves with an empty note and ignores annotated or old ones', () => {
    const papers = [
      { id: 'a', savedAt: new Date(now - 1 * day).toISOString(), notes: '' },
      { id: 'b', savedAt: new Date(now - 2 * day).toISOString(), notes: '   ' },
      { id: 'c', savedAt: new Date(now - 3 * day).toISOString(), notes: 'because' },
      { id: 'd', savedAt: new Date(now - 20 * day).toISOString(), notes: '' },
      { id: 'e', notes: '' },
    ]
    expect(savedWithoutWhy(papers, { now }).map((p) => p.id)).toEqual(['a', 'b'])
  })
  it('is defensive on shape', () => {
    expect(savedWithoutWhy(null)).toEqual([])
    expect(savedWithoutWhy([undefined, {}])).toEqual([])
  })
})

describe('evidence save and export contract', () => {
  it('retains source and unresolved proposals, while asserting only the correctly bound control', () => {
    const text = 'Mortality was 10% in Treatment A and 20% in Treatment B.'
    const quantity = { name: 'Mortality', quantity_type: 'comparison', first_label: 'Treatment A', first_value: 10, second_label: 'Treatment B', second_value: 20, unit: '%', source_quote: text }
    const swapped = { ...quantity, first_value: 20, second_value: 10 }
    const result = { paper: { id: 'synthetic', pmid: '123' }, sourceDoc: { text }, rows: [quantity, swapped].map((q) => ({ quantity: q, verdict: verify(q, text) })) }
    const paper = JSON.parse(JSON.stringify(buildPaperRecord(result, {}, { notes: 'Personal annotation' })))
    expect(paper.quantities).toHaveLength(2)
    expect(paper.quantities[0].verdict.relationshipValidated).toBe(true)
    expect(paper.quantities[1].verdict.relationshipValidated).toBe(false)
    expect(paper.fullText).toBe(text)
    expect(paper.notes).toBe('Personal annotation')
    const note = sourceNoteMd(paper)
    expect(note).toContain('Treatment A: 10')
    expect(note).not.toContain('Treatment A: 20')
    expect(note).toContain('Source receipt: ' + text)
    expect(note).toContain('source-located')
  })
})
