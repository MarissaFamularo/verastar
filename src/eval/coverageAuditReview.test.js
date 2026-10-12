// Independent reviewer counterexamples. Synthetic source only; no paid requests.
import { describe, it, expect } from 'vitest'
import { DOMParser } from 'linkedom'
import { planSinglePaper } from './singlePaper.js'
import { planCoverageAudit, validateCoverageAudit } from './coverageAudit.js'
globalThis.DOMParser = DOMParser
const sentence = 'Clinical outcome was reported only for the enrolled patients.'
const table = 'Safety outcome | Treated | Control\nMajor bleeding | 4 | 7'
const f = (q = sentence) => ({ category: 'major_harm_safety', outcome: 'Bleeding', population: null, timepoint: null, source_quote: q, assessment: 'possibly_missing', extraction_row_indices: [], reason: 'Potential omission.' })
const raw = (q) => ({ findings: [f(q)], uncertainty_notes: [] })
const context = { corpusText: sentence, tablesText: table, rowCount: 1 }
describe('independent coverage audit rejection checks', () => {
  it('locates a table-only omission in the exact supplied tables', () => {
    expect(validateCoverageAudit(raw('Major bleeding | 4 | 7'), context).accepted).toHaveLength(1)
  })
  it('cannot invent a quote by joining prose and table boundaries', () => {
    expect(validateCoverageAudit(raw('enrolled patients. Safety outcome'), context).accepted).toHaveLength(0)
  })
  for (const mutation of [r => ({ ...r, complete: true }), r => { delete r.uncertainty_notes; return r }, r => ({ ...r, uncertainty_notes: 4 })]) {
    it('refuses all findings when the response envelope is malformed', () => {
      const result = validateCoverageAudit(mutation(raw(sentence)), context)
      expect(result.accepted).toHaveLength(0)
      expect(result.status).toBe('coverage-undetermined')
    })
  }
  it('refuses a fake extraction disguised only with mode live', async () => {
    const xml = '<article><body><p>Synthetic results in 12 patients.</p></body></article>'
    const plan = await planSinglePaper({caseId:'ZZ-1', pmid:'1', pmcXml:xml})
    await expect(planCoverageAudit({caseId:'ZZ-1', pmid:'1', pmcXml:xml, extractionReport:{mode:'live',plan,run:{provider:'fake',rows:[]}}})).rejects.toThrow()
  })
})
