// rev2Regression.test.js — the three gaps an independent review reproduced in the six-fix
// patch (REV1), each locked here. OFFLINE: every model call is mocked. Saved inputs are
// Development-set fixtures only (src/pipeline/__fixtures__/devset); synthetic inputs are
// marked SYNTHETIC.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../lib/anthropic.js', () => ({
  MODELS: { extraction: 'x', triage: 'x', interview: 'x', fast: 'x' },
  extractStructured: vi.fn(),
  getNcbiKey: () => '',
  getNcbiEmail: () => '',
}))

import { extractStructured } from '../lib/anthropic.js'
import { fmtNum, ciLabel } from '../lib/format.js'
import { findPrimary } from './primaryResult.js'
import { triage } from './triage.js'
import { selectEvidenceContext, EVIDENCE_CHARS } from './evidenceContext.js'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'devset')
const load = (id) => JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'))
const notFlagged = (row) => !row.verdict.flagged
const q = (o) => ({ name: '', quantity_type: 'single', value: null, range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, unit: null, ci_low: null, ci_high: null, p_value: null, source_quote: '', location_hint: null, ...o })
const verifiedOf = (rows) => rows.filter(notFlagged).map((r) => ({ name: r.quantity.name, value: fmtNum(r.quantity), quote: r.quantity.source_quote }))

beforeEach(() => extractStructured.mockReset())

// A SUPPORTIVE checker: every claim it receives comes back supported.
function mockWriterThenSupportiveChecker(ranking) {
  extractStructured
    .mockResolvedValueOnce({ rankings: [ranking] })
    .mockImplementation(async (args) => ({
      verdicts: [...String(args?.content || '').matchAll(/^\[([^\]]+)\] CLAIM/gm)].map((m) => ({ id: m[1], supported: true, reason: 'supported' })),
    }))
}

// ---------------------------------------------------------------------------------------
describe('gap 1 — a missing primary is an explicit state, and the main finding goes number-free', () => {
  const SECONDARY_ONLY = [ // SYNTHETIC
    { quantity: q({ name: 'Secondary outcome: HF hospitalization (hazard ratio)', value: 0.8, ci_low: 0.7, ci_high: 0.9, source_quote: 'hazard ratio, 0.80; 95% CI, 0.70 to 0.90' }), verdict: { flagged: false } },
    { quantity: q({ name: 'Secondary outcome: CV death (hazard ratio)', value: 0.95, source_quote: 'hazard ratio, 0.95' }), verdict: { flagged: true } },
  ]

  it('findPrimary never returns null', () => {
    expect(findPrimary([])).toMatchObject({ state: 'no-results', name: null, verified: false, indexes: [] })
    expect(findPrimary(undefined)).toMatchObject({ state: 'no-results' })
    expect(findPrimary(SECONDARY_ONLY)).toMatchObject({ state: 'unknown', name: null, verified: false, indexes: [] })
  })

  it('row zero is not promoted: an unlabelled first row leaves the primary unknown', () => {
    const rows = [{ quantity: q({ name: 'HF hospitalization, drug vs placebo (hazard ratio)', value: 0.8, source_quote: 'hazard ratio, 0.80' }), verdict: { flagged: false } }]
    expect(findPrimary(rows)).toMatchObject({ state: 'unknown' })
  })

  it('identifies by name, then location hint — never by position or by quote text', () => {
    const byQuote = [
      { quantity: q({ name: 'Death, A vs B', source_quote: 'death occurred in 5%' }), verdict: { flagged: false } },
      { quantity: q({ name: 'Composite, A vs B', source_quote: 'the primary end point occurred in 10% and 12%' }), verdict: { flagged: true } },
    ]
    expect(findPrimary(byQuote)).toMatchObject({ state: 'unknown', name: null, verified: false, indexes: [] })
    const byName = [{ quantity: q({ name: 'Primary composite, A vs B' }), verdict: { flagged: false } }]
    expect(findPrimary(byName)).toMatchObject({ state: 'identified', basis: 'name', verified: true, indexes: [0] })
    const byHint = [{ quantity: q({ name: 'Composite, A vs B', location_hint: 'Results, primary outcome' }), verdict: { flagged: false } }]
    expect(findPrimary(byHint)).toMatchObject({ state: 'identified', basis: 'location', verified: true })
    // a subgroup labelled "primary" never stands in for the primary
    const subgroup = [{ quantity: q({ name: 'Primary end point in asymptomatic patients (hazard ratio)' }), verdict: { flagged: false } }]
    expect(findPrimary(subgroup)).toMatchObject({ state: 'unknown' })
  })

  // 2026-10-13 beta policy: an unknown primary no longer withholds the summary. The
  // finding loses its numbers (the primary is not verified, so any cited number is a
  // non-primary result), the writer is told not to headline any listed result, and the
  // number-free sentence is still audited by the model checker.
  it('REAL triage flow, SUPPORTIVE checker: secondary-only rows → number-free finding, model-checked, not withheld', async () => {
    mockWriterThenSupportiveChecker({ id: 'p1', score: 80, tier: 1, finding: 'Drug X reduced HF hospitalization (HR 0.80 (CI 0.70–0.90)).', finding_plain: 'Drug X reduced HF hospitalization.', design_caution: 'Open-label design.', relevance: 'r' })
    const [take] = await triage({ candidates: [{ id: 'p1', title: 'T', summary: 'hazard ratio, 0.80; 95% CI, 0.70 to 0.90', verified: verifiedOf(SECONDARY_ONLY), primary: findPrimary(SECONDARY_ONLY, notFlagged) }] })
    expect(take.finding).toBe('Drug X reduced HF hospitalization.')
    expect(take.check).toEqual({ verdict: 'supported', reason: 'supported' })
    expect(take.check.withheld).toBeUndefined()
    expect(extractStructured.mock.calls[0][0].content).toContain('Primary result: NOT identified by the app')
    const checkerPrompt = extractStructured.mock.calls[1][0].content
    expect(checkerPrompt).toContain('[p1] CLAIM')
    expect(take.cautionCheck.verdict).toBe('supported')
  })

  it('REAL triage flow on a SAVED row (PAD-05: no row labelled primary), SUPPORTIVE checker → rendered number-free', async () => {
    const d = load('PAD-05')
    expect(findPrimary(d.rows, notFlagged).state).toBe('unknown')
    mockWriterThenSupportiveChecker({ id: d.pmid, score: 50, tier: 1, finding: d.recordedTake.finding, finding_plain: d.recordedTake.finding, design_caution: d.recordedTake.designCaution, relevance: d.recordedTake.relevance })
    const [take] = await triage({ candidates: [{ id: d.pmid, title: 'Cilostazol', summary: d.sourceDoc.text, verified: verifiedOf(d.rows), primary: findPrimary(d.rows, notFlagged) }] })
    expect(take.check.verdict).toBe('supported')
    expect(take.check.withheld).toBeUndefined()
    expect(take.finding).not.toBe('')
    expect(take.finding).not.toMatch(/\d/)
  })

  it('an explicit null primary is treated as unknown (number-free, checked), not as "fine"', async () => {
    mockWriterThenSupportiveChecker({ id: 'p1', score: 1, tier: 2, finding: 'Improved outcomes (HR 0.80 (CI 0.70–0.90)).', finding_plain: 'Improved outcomes.', design_caution: '', relevance: '' })
    const [take] = await triage({ candidates: [{ id: 'p1', title: 'T', summary: 's', verified: [{ name: 'HF hospitalization (hazard ratio)', value: '0.80 hazard ratio (CI 0.70–0.90)', quote: 'hazard ratio, 0.80' }], primary: null }] })
    expect(take.finding).toBe('Improved outcomes.')
    expect(take.check.withheld).toBeUndefined()
    expect(extractStructured.mock.calls[0][0].content).toContain('Primary result: NOT identified by the app')
  })

  it('a refuting checker still withholds an unknown-primary finding', async () => {
    extractStructured
      .mockResolvedValueOnce({ rankings: [{ id: 'p1', score: 80, tier: 1, finding: 'Drug X reduced HF hospitalization.', finding_plain: 'Drug X reduced HF hospitalization.', design_caution: '', relevance: '' }] })
      .mockImplementation(async (args) => ({
        verdicts: [...String(args?.content || '').matchAll(/^\[([^\]]+)\] CLAIM/gm)].map((m) => ({ id: m[1], supported: false, reason: 'overstates the direction' })),
      }))
    const [take] = await triage({ candidates: [{ id: 'p1', title: 'T', summary: 's', verified: verifiedOf(SECONDARY_ONLY), primary: findPrimary(SECONDARY_ONLY, notFlagged) }] })
    expect(take.check.verdict).toBe('refuted')
  })

  it('an identified primary still goes to the checker (supported stays supported)', async () => {
    const d = load('HF-13') // primary identified and verified
    mockWriterThenSupportiveChecker({ id: d.pmid, score: 50, tier: 1, finding: d.recordedTake.finding, finding_plain: '', design_caution: '', relevance: '' })
    const [take] = await triage({ candidates: [{ id: d.pmid, title: 'REVIVED', summary: d.sourceDoc.text, verified: verifiedOf(d.rows), primary: findPrimary(d.rows, notFlagged) }] })
    expect(take.check).toEqual({ verdict: 'supported', reason: 'supported' })
  })

  it('no extracted results (narrative review) is not "unknown": number-free finding is model-checked', async () => {
    mockWriterThenSupportiveChecker({ id: 'r1', score: 1, tier: 3, finding: 'A narrative review of perfusion methods.', finding_plain: '', design_caution: '', relevance: '' })
    const [take] = await triage({ candidates: [{ id: 'r1', title: 'Review', summary: 'review text', verified: [], primary: findPrimary([]) }] })
    expect(take.check.verdict).toBe('supported')
  })
})

// ---------------------------------------------------------------------------------------
describe('gap 2 — CI level and kind are bound to the quantity\'s own interval (SYNTHETIC quotes)', () => {
  const A = 'the hazard ratio was 0.80 (95% CI, 0.70 to 0.90); the mean difference was 1.5 (90% CI, 1.0 to 2.0)'
  const B = 'the mean difference was 1.5 (90% CI, 1.0 to 2.0); the hazard ratio was 0.80 (95% CI, 0.70 to 0.90)'
  const HR = { value: 0.8, ci_low: 0.7, ci_high: 0.9 }
  const MD = { value: 1.5, ci_low: 1.0, ci_high: 2.0 }

  it('95% result first, 90% result second', () => {
    expect(ciLabel(q({ ...HR, source_quote: A }))).toBe('CI')
    expect(ciLabel(q({ ...MD, source_quote: A }))).toBe('90% CI')
    expect(fmtNum(q({ ...MD, source_quote: A }))).toBe('1.5 (90% CI 1.0–2.0)')
  })

  it('90% result first, 95% result second', () => {
    expect(ciLabel(q({ ...MD, source_quote: B }))).toBe('90% CI')
    expect(ciLabel(q({ ...HR, source_quote: B }))).toBe('CI')
    expect(fmtNum(q({ ...HR, source_quote: B }))).toBe('0.80 (CI 0.70–0.90)')
  })

  it('mixed credible and confidence intervals in one quote, both orders', () => {
    const M1 = 'risk difference, -1.4 points (95% Bayesian credible interval, -4.9 to 2.1); hazard ratio, 0.85 (95% confidence interval, 0.60 to 1.20)'
    const M2 = 'hazard ratio, 0.85 (95% confidence interval, 0.60 to 1.20); risk difference, -1.4 points (95% Bayesian credible interval, -4.9 to 2.1)'
    for (const M of [M1, M2]) {
      expect(ciLabel(q({ value: 0.85, ci_low: 0.6, ci_high: 1.2, source_quote: M }))).toBe('CI')
      expect(ciLabel(q({ value: -1.4, ci_low: -4.9, ci_high: 2.1, source_quote: M }))).toBe('95% credible interval')
    }
  })

  it('a 99% marker after the interval, inside the same bracket, binds; an unlabelled parenthesis interval is not a CI', () => {
    expect(ciLabel(q({ value: 282, ci_low: 60, ci_high: 505, source_quote: 'difference 282 m (60 to 505, 99% CI)' }))).toBe('99% CI')
    expect(ciLabel(q({ value: 1.2, ci_low: 1.0, ci_high: 1.4, source_quote: 'HR 0.8 (90% CI 0.7-0.9); OR 1.2 (1.0-1.4)' }))).toBe('interval')
  })

  it('integration: a group-pair row cannot display a separate estimate CI, in either order', () => {
    const pair = { quantity_type: 'comparison', first_label: 'a', first_value: 10.2, second_label: 'b', second_value: 3.7, unit: '%', ci_low: 2.0, ci_high: 3.9 }
    const G1 = 'rates were 10.2% and 3.7% (hazard ratio, 2.8; 95% CI, 2.0 to 3.9); the difference in a later window was 1.9 percentage points (95% CI, 0.8 to 3.0)'
    const G2 = 'the difference in a later window was 1.9 percentage points (95% CI, 0.8 to 3.0); rates were 10.2% and 3.7% (hazard ratio, 2.8; 95% CI, 2.0 to 3.9)'
    for (const G of [G1, G2]) expect(fmtNum(q({ ...pair, source_quote: G }))).not.toContain('CI')
    expect(fmtNum(q({ ...pair, ci_low: 0.8, ci_high: 3.0, source_quote: G1 }))).not.toContain('CI')
  })

  it('saved single estimates preserve their labels; pair CIs remain suppressed', () => {
    expect(fmtNum(load('CAR-13').rows[1].quantity)).toBe('0.51% (90% CI -1.89–2.91)')
    expect(fmtNum(load('PAD-01').rows[0].quantity)).toBe('282 m (99% CI 60–505)')
    expect(fmtNum(load('AS-08').rows[1].quantity)).toBe('-1.4 percentage points (95% credible interval -4.9–2.1)')
    expect(fmtNum(load('CAD-01').rows[2].quantity)).not.toContain('CI')
  })
})

// ---------------------------------------------------------------------------------------
describe('gap 3 — dedup against the RETAINED abstract, not the whole abstract (SYNTHETIC text)', () => {
  const primary = 'The primary outcome occurred in 41% and 36% (hazard ratio, 0.86; 95% CI, 0.72 to 1.04; P = 0.12).'
  const longAbstract = `${'Background sentence about the disease. '.repeat(90)}${primary} Conclusions follow.`

  it('primary past the cutoff, also in the body → kept, within the limit', () => {
    expect(longAbstract.indexOf(primary)).toBeGreaterThan(EVIDENCE_CHARS / 2)
    const body = `${'Intro text. '.repeat(500)}${primary} ${'Discussion text. '.repeat(300)}`
    const ctx = selectEvidenceContext({ text: body, abstract: longAbstract, quotes: [primary] })
    expect(ctx.length).toBeLessThanOrEqual(EVIDENCE_CHARS)
    expect(ctx).toContain(primary)
  })

  it('primary past the cutoff, only in the abstract → kept from the abstract tail', () => {
    const ctx = selectEvidenceContext({ text: 'Intro text. '.repeat(800), abstract: longAbstract, quotes: [primary] })
    expect(ctx.length).toBeLessThanOrEqual(EVIDENCE_CHARS)
    expect(ctx).toContain(primary)
  })

  it('primary among many results with a tight budget is still kept first', () => {
    const others = Array.from({ length: 12 }, (_, i) => `Secondary result ${i} was ${'x'.repeat(380)} reported.`)
    const body = `${'Intro text. '.repeat(400)}${primary} ${others.join(' ')}`
    const ctx = selectEvidenceContext({ text: body, abstract: longAbstract, quotes: [primary, ...others] })
    expect(ctx.length).toBeLessThanOrEqual(EVIDENCE_CHARS)
    expect(ctx).toContain(primary)
  })

  it('a quote inside the RETAINED abstract is not repeated as an excerpt', () => {
    const early = 'Mortality was 5% in both groups.'
    const abstract = `${early} ${'Filler sentence. '.repeat(250)}`
    const body = `${'Intro text. '.repeat(600)}${early} ${'More text. '.repeat(100)}`
    const ctx = selectEvidenceContext({ text: body, abstract, quotes: [early] })
    expect(ctx.split(early).length - 1).toBe(1)
  })

  it('a quote straddling the retained cut keeps its remainder', () => {
    const abstract = `${'a'.repeat(2990)} The straddling primary result was null overall.`
    const ctx = selectEvidenceContext({ text: 'Intro. '.repeat(1200), abstract, quotes: ['The straddling primary result was null overall.'] })
    expect(ctx.length).toBeLessThanOrEqual(EVIDENCE_CHARS)
    expect(ctx).toContain('result was null overall.')
  })
})
