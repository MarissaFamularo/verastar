import { describe, expect, it } from 'vitest'
import { buildPaperRecord } from './save.js'

describe('buildPaperRecord — design appraisal survives a manual or digest save', () => {
  it('persists design caution separately from the finding and verified facts', () => {
    const res = {
      paper: { id: '42335023', pmid: '42335023' },
      citation: { title: 'National comparative analysis' },
      design: 'retrospective_cohort',
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
    expect(paper.designCaution).toBe(take.designCaution)
    expect(paper.cautionCheck).toEqual({ verdict: 'supported', reason: '' })
    expect(paper.finding).toBe(take.finding)
    expect(paper.score).toBe(88)
    expect(paper.relevance).toBe(take.relevance)
    expect(paper.saveSource).toBe('manual')
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
