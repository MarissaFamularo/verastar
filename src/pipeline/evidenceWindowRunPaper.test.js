// runPaper attaches the evidence window beside — never instead of — the complete
// verification corpus. SYNTHETIC full-text source; fetch and extraction mocked.
import { describe, it, expect, vi } from 'vitest'

const BODY = 'An earlier trial reported a hazard ratio of 0.50 (95% CI 0.40-0.62) [3]. The primary endpoint occurred in 61 of 405 and 58 of 407 patients.'
const ABSTRACT_ONLY_SENTENCE = 'Synthetic abstract-only finding: fatal or disabling stroke occurred in 3.7 per cent of patients at five years.'

vi.mock('./sources.js', async (importOriginal) => ({
  assembleExtractionSource: (await importOriginal()).assembleExtractionSource,
  fetchCitation: vi.fn(async (pmid) => ({ pmid, verified: true, title: 'Synthetic', pubtypes: [] })),
  pmidToPmcid: vi.fn(async () => 'PMC0000001'),
  fetchPmcFullText: vi.fn(async () => ({
    hasBody: true,
    tier: 'full_text',
    text: BODY,
    tables: 'Table 1\nAge | 69.1',
    sections: [
      { label: 'Introduction', kind: 'background', text: 'An earlier trial reported a hazard ratio of 0.50 (95% CI 0.40-0.62) [3].' },
      { label: 'Results', kind: 'results', text: 'The primary endpoint occurred in 61 of 405 and 58 of 407 patients.' },
    ],
    abstractParts: [{ label: 'Methods', text: 'Adults were randomized.' }, { label: 'Results', text: ABSTRACT_ONLY_SENTENCE }],
  })),
  fetchAbstracts: vi.fn(),
  fetchRegistry: vi.fn(),
  parseRegistryOutcomes: vi.fn(() => []),
  REGISTRY_OUTCOME_MAP: {},
  searchPubmed: vi.fn(),
  fetchCitations: vi.fn(),
  searchPaceMs: () => 0,
}))
vi.mock('./extract.js', async (importOriginal) => ({
  ...(await importOriginal()),
  extractQuantities: vi.fn(async () => ({ design: 'RCT', quantities: [
    { name: 'earlier trial death', quantity_type: 'single', value: 0.5, unit: 'HR', ci_low: 0.4, ci_high: 0.62, p_value: null, source_quote: 'a hazard ratio of 0.50 (95% CI 0.40-0.62)' },
    { name: 'fatal or disabling stroke', quantity_type: 'single', value: 3.7, unit: 'per cent', ci_low: null, ci_high: null, p_value: null, source_quote: 'Synthetic abstract-only finding: fatal or disabling stroke occurred in 3.7 per cent of patients at five years.' },
  ] })),
}))

import { runPaper } from './pipeline.js'
import { buildPaperRecord } from './save.js'
import { TIERS, verify } from './verify.js'

const ABSTRACT_BLOCK = `PUBLISHER ABSTRACT:\nMethods: Adults were randomized.\nResults: ${ABSTRACT_ONLY_SENTENCE}`
const CORPUS = `${ABSTRACT_BLOCK}\n\n${BODY}`

describe('runPaper', () => {
  it('stores the window and shares one corpus between extraction, verification and the saved record', async () => {
    const res = await runPaper({ id: '9', pmid: '9' })
    expect(res.error).toBeUndefined()
    // sourceDoc is the exact corpus the model read (abstract block + body), tables separate.
    expect(res.sourceDoc).toEqual({ text: CORPUS, tables: 'Table 1\nAge | 69.1' })
    expect(res.sourceCoverage).toEqual({ abstractPresent: true, bodyPresent: true, tablesPresent: true, figureImageTextExtracted: false })
    // Ranking window is unchanged: still body-structure based, never the abstract block.
    expect(res.evidenceWindow).toMatchObject({ kind: 'results', basis: 'full_text_sections' })
    expect(res.evidenceWindow.text).not.toContain('0.50')
    expect(res.evidenceWindow.text).not.toContain('PUBLISHER ABSTRACT')
    // The verifier reads the full corpus: the Introduction-only value is located as before.
    expect(res.rows[0].verdict.tier).toBe(TIERS.ESTIMATE)
    // The abstract-only quantity is now locatable (it was not in the old body-only corpus).
    expect(res.rows[1].verdict.sourceLocated).toBe(true)
    expect(res.rows[1].verdict.numericCoverage).toBe(true)
    expect(res.rows[1].verdict.tier).not.toBe(TIERS.FLAGGED)
    // The model was given exactly corpus + TABLES.
    const { extractQuantities } = await import('./extract.js')
    expect(vi.mocked(extractQuantities).mock.calls[0][0].sourceText).toBe(`${CORPUS}\n\nTABLES:\nTable 1\nAge | 69.1`)
    // The saved record keeps the same corpus, and a later recheck over it reproduces the verdicts.
    const saved = buildPaperRecord(res, null)
    expect(saved.fullText).toBe(CORPUS)
    expect(saved.tables).toBe('Table 1\nAge | 69.1')
    for (let i = 0; i < res.rows.length; i++) {
      const recheck = verify(res.rows[i].quantity, { text: saved.fullText, tables: saved.tables }, { sourceTier: res.source.tier })
      expect(recheck.tier).toBe(res.rows[i].verdict.tier)
      expect(recheck.flagged).toBe(res.rows[i].verdict.flagged)
    }
  })
})
