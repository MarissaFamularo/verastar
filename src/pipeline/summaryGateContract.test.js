// summaryGateContract.test.js — the six numeric-guard acceptance probes
// (docs/evidence/2026-10-17/verifier/numeric-guard/acceptance-probes.js.txt), now against
// the number guard PLUS claim binding (numberBinding.js). Production's sanitizer retained
// four mutants; each must now fall back. No model calls.
import { describe, expect, it } from 'vitest'
import { sanitizeRanking } from './triage.js'
import { bindFindingNumbers } from './numberBinding.js'

const verified = [
  { name: 'Bleeding, treatment A vs treatment B, intention-to-treat hazard ratio', value: '0.44 hazard ratio (CI 0.34–0.55)', quote: 'In the intention-to-treat analysis, treatment A versus treatment B reduced bleeding (HR 0.44, CI 0.34–0.55).' },
  { name: 'MACE, treatment A vs treatment B, intention-to-treat hazard ratio', value: '1.05 hazard ratio (CI 0.83–1.32)', quote: 'In the intention-to-treat analysis, MACE for treatment A versus treatment B had HR 1.05 (CI 0.83–1.32).' },
]
const primary = { state: 'identified', name: verified[0].name, verified: true, indexes: [0], basis: 'source' }
const sanitize = (finding) => sanitizeRanking({ id: 'test', score: 80, tier: 1, finding, finding_plain: 'The trial compared treatment A with treatment B.', design_caution: '', relevance: '' }, verified, { primary })
const correct = 'In the intention-to-treat analysis, treatment A versus treatment B reduced bleeding (0.44 hazard ratio (CI 0.34–0.55)).'

describe('source-bound summary retention acceptance contract', () => {
  it('retains the exact matched outcome, comparison, analysis and estimate', () => {
    expect(sanitize(correct).finding).toBe(correct)
    expect(bindFindingNumbers(correct, verified)).toMatchObject({ ok: true })
  })
  it.each([
    ['outcome swap', correct.replace('bleeding', 'MACE'), 'outcome-mismatch'],
    ['comparator reversal', correct.replace('treatment A versus treatment B', 'treatment B versus treatment A'), 'comparator-reversed'],
    ['analysis substitution', correct.replace('intention-to-treat', 'per-protocol'), 'analysis-mismatch'],
    ['CI borrowed from another result', correct.replace('0.34–0.55', '0.83–1.32'), 'interval-borrowed'],
  ])('rejects %s before preserving numbers', (_name, finding, kind) => {
    const out = sanitize(finding)
    expect(out.finding).not.toBe(finding)
    expect(out.finding).toBe('The trial compared treatment A with treatment B.')
    expect(out.bindingViolations.map((v) => v.kind)).toContain(kind)
  })
  it('rejects an unverified effect magnitude', () => {
    const s = correct.replace('0.44', '0.45')
    expect(sanitize(s).finding).not.toBe(s)
  })
  it('keeps a sentence that cites both results in their own segments', () => {
    const both = 'Treatment A versus treatment B reduced bleeding (0.44 hazard ratio (CI 0.34–0.55)) with no statistically clear difference in MACE (1.05 hazard ratio (CI 0.83–1.32)).'
    expect(sanitize(both).finding).toBe(both)
  })
  it('leaves a composite that names its components to the model checker (no deterministic rejection)', () => {
    const rows = [
      { name: 'Primary composite outcome (total HF hospitalizations and CV death), drug vs placebo, rate ratio', value: '0.87 rate ratio (CI 0.75–1.01)', quote: 'rate ratio, 0.87; 95% CI, 0.75 to 1.01' },
      { name: 'Death from cardiovascular causes, drug vs placebo, hazard ratio', value: '0.95 hazard ratio (CI 0.79–1.16)', quote: 'hazard ratio, 0.95; 95% CI, 0.79 to 1.16' },
    ]
    const finding = 'Drug did not significantly lower the composite of total heart failure hospitalizations and cardiovascular death versus placebo (0.87 rate ratio (CI 0.75–1.01)).'
    expect(bindFindingNumbers(finding, rows).ok).toBe(true)
  })
})
