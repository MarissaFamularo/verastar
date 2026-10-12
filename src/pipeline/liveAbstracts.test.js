// The three papers from the 2026-10-12 new-user digest. Abstracts are the PubMed records
// (fetched 2026-10-12); the quantities are the local clauses an extractor is asked to copy.
// Verification stays literal: a form the source did not print still fails.

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
import { verify, TIERS } from './verify.js'
import { findPrimary, PRIMARY_UNKNOWN_REASON } from './primaryResult.js'
import { triage } from './triage.js'
import { fmtNum, ciLabel } from '../lib/format.js'
import { isRelationshipValidated } from '../lib/evidenceVersion.js'

const FIXTURE = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'live-2026-10-12.json'), 'utf8'))
const abstract = (pmid) => FIXTURE[pmid].abstract

const single = (fields) => ({
  quantity_type: 'single', range_low: null, range_high: null, first_label: null, first_value: null,
  second_label: null, second_value: null, p_value: null, location_hint: 'Results', unit: null, ...fields,
})
const comparison = (fields) => ({
  quantity_type: 'comparison', value: null, range_low: null, range_high: null, first_label: null,
  second_label: null, unit: '%', ci_low: null, ci_high: null, p_value: null, location_hint: 'Results', ...fields,
})
const row = (quantity, verdict) => ({ quantity, verdict })

beforeEach(() => extractStructured.mockReset())

describe('PMID 42855019 — bracketed hazard ratios, J Vasc Surg', () => {
  const src = abstract('42855019')
  const hr = single({
    name: 'Two-year major amputation, peroneal versus AT/PT runoff',
    unit: 'HR', value: 1.81, ci_low: 1.04, ci_high: 3.13,
    source_quote: 'higher risk of major amputation (HR 1.81 [1.04-3.13])',
  })

  it('verifies the printed bracket interval and does not call it a confidence interval', () => {
    const verdict = verify(hr, src)
    expect(verdict.tier).toBe(TIERS.ESTIMATE)
    expect(verdict.flagged).toBe(false)
    expect(isRelationshipValidated(verdict)).toBe(true)
    expect(verdict.reason).toMatch(/bracketed interval/)
    expect(verdict.reason).toMatch(/did not label the interval as a confidence interval/)
    expect(ciLabel(hr)).toBe('interval')
    expect(fmtNum(hr)).toBe('1.81 HR (interval 1.04–3.13)')
  })

  it('refuses a bracket whose bounds are not the ones printed', () => {
    const wrong = { ...hr, ci_high: 3.14 }
    expect(verify(wrong, src).tier).not.toBe(TIERS.ESTIMATE)
  })

  it('refuses an integer bracket that could be a citation', () => {
    const quote = 'HR 2 [12-34]'
    expect(verify(single({ name: 'amputation', unit: 'HR', value: 2, ci_low: 12, ci_high: 34, source_quote: quote }), quote).tier).not.toBe(TIERS.ESTIMATE)
  })

  it('refuses the three-group percentage sentence as a two-group comparison', () => {
    const quote = 'Unadjusted two-year major amputation rates were significantly higher in the peroneal group (19% vs. 9.4% [AT] vs. 8.7% [PT]; P<.001)'
    const verdict = verify(comparison({ name: 'Two-year major amputation', first_value: 19, second_value: 9.4, source_quote: quote }), src)
    expect(verdict.tier).not.toBe(TIERS.COMPARISON)
    expect(isRelationshipValidated(verdict)).toBe(false)
  })

  it('identifies the declared primary outcomes from the methods sentence, not from row order', () => {
    const male = single({
      name: 'Two-year MALE, peroneal versus AT/PT runoff', unit: 'HR', value: 1.52, ci_low: 1.03, ci_high: 2.25,
      source_quote: 'and MALE (HR 1.52 [1.03-2.25])',
    })
    const rows = [row(hr, verify(hr, src)), row(male, verify(male, src))]
    const primary = findPrimary(rows, (r) => isRelationshipValidated(r.verdict), src)
    expect(primary).toMatchObject({ state: 'identified', basis: 'source', verified: true })
    expect(primary.name).toMatch(/major amputation/)
    expect(primary.indexes).toEqual([0, 1])
  })
})

describe('PMID 42854197 — RAO after CEA versus CAS', () => {
  const src = abstract('42854197')
  const raoQuote = 'higher risks of RAO (0.421% vs 0.257%; OR 1.64; 95% CI, 1.12-2.41)'
  const raoCompare = comparison({
    name: '1-year retinal artery occlusion, CAS versus CEA',
    first_value: 0.421, second_value: 0.257, source_quote: raoQuote,
  })
  const raoOr = single({
    name: '1-year retinal artery occlusion, CAS versus CEA',
    unit: 'OR', value: 1.64, ci_low: 1.12, ci_high: 2.41, source_quote: raoQuote,
  })
  const strokeQuote = 'higher odds of stroke (6.20% vs 4.43%; OR 1.42; 1.25-1.62)'
  const strokeCompare = comparison({
    name: '1-year stroke, CAS versus CEA',
    first_value: 6.2, second_value: 4.43, source_quote: strokeQuote,
  })
  const strokeOr = single({
    name: '1-year stroke, CAS versus CEA',
    unit: 'OR', value: 1.42, ci_low: 1.25, ci_high: 1.62, source_quote: strokeQuote,
  })

  it('verifies the RAO percentages and the labelled odds ratio in the same clause', () => {
    expect(verify(raoCompare, src).tier).toBe(TIERS.COMPARISON)
    expect(verify(raoOr, src).tier).toBe(TIERS.ESTIMATE)
  })

  it('verifies the stroke percentages and still refuses the unlabelled interval after OR', () => {
    expect(verify(strokeCompare, src).tier).toBe(TIERS.COMPARISON)
    const verdict = verify(strokeOr, src)
    expect(verdict.tier).not.toBe(TIERS.ESTIMATE)
    expect(isRelationshipValidated(verdict)).toBe(false)
  })

  it('names RAO as the primary outcome and does not promote stroke', () => {
    const crao = single({
      name: '1-year central retinal artery occlusion, CAS versus CEA',
      unit: 'OR', value: 2.3, ci_low: 1.1, ci_high: 4.84,
      source_quote: 'CRAO (OR 2.30; 1.10-4.84)',
    })
    const rows = [
      row(strokeCompare, verify(strokeCompare, src)),
      row(raoCompare, verify(raoCompare, src)),
      row(raoOr, verify(raoOr, src)),
      row(crao, verify(crao, src)),
    ]
    const primary = findPrimary(rows, (r) => isRelationshipValidated(r.verdict), src)
    expect(primary).toMatchObject({ state: 'identified', basis: 'source', verified: true, indexes: [1, 2] })
    expect(primary.name).toMatch(/retinal artery occlusion/)
  })
})

describe('PMID 42855613 — apixaban versus rivaroxaban meta-analysis', () => {
  const src = abstract('42855613')
  const rr = (name, value, low, high, quote) => single({
    name, unit: 'RR', value, ci_low: low, ci_high: high, source_quote: quote,
  })
  const rows = [
    ['Recurrent VTE, apixaban versus rivaroxaban', 0.85, 0.74, 0.98, 'lower risk of recurrent VTE compared to rivaroxaban (RR 0.85; 95% CI 0.74-0.98)'],
    ['Major bleeding, apixaban versus rivaroxaban', 0.72, 0.65, 0.81, 'reduction in major bleeding risk (RR 0.72; 95% CI 0.65-0.81)'],
    ['Net clinical harm, apixaban versus rivaroxaban', 0.76, 0.68, 0.86, 'lower risk of net clinical harm (RR 0.76; 95% CI 0.68-0.86)'],
    ['All-cause mortality, apixaban versus rivaroxaban', 0.95, 0.8, 1.12, 'no statistically significant difference was observed in all-cause mortality (RR 0.95; 95% CI 0.80-1.12)'],
  ].map(([name, value, low, high, quote]) => {
    const quantity = rr(name, value, low, high, quote)
    return row(quantity, verify(quantity, src))
  })

  it('verifies all four pooled ratios', () => {
    expect(rows.map((r) => r.verdict.tier)).toEqual([TIERS.ESTIMATE, TIERS.ESTIMATE, TIERS.ESTIMATE, TIERS.ESTIMATE])
  })

  it('does not invent a primary endpoint the paper never named', () => {
    expect(findPrimary(rows, (r) => isRelationshipValidated(r.verdict))).toMatchObject({ state: 'unknown' })
    expect(findPrimary(rows, (r) => isRelationshipValidated(r.verdict), src)).toMatchObject({
      state: 'unspecified', basis: 'no-declared-primary', verified: true,
    })
  })

  it('a supportive checker may keep the summary; a secondary-only paper is still withheld', async () => {
    extractStructured
      .mockResolvedValueOnce({ rankings: [{ id: '42855613', score: 70, tier: 1, finding: 'Apixaban had less recurrent VTE (RR 0.85 (CI 0.74–0.98)).', finding_plain: 'Less recurrent VTE.', design_caution: 'Mostly observational.', relevance: 'VTE' }] })
      .mockImplementation(async (args) => ({
        verdicts: [...String(args?.content || '').matchAll(/^\[([^\]]+)\] CLAIM/gm)].map((m) => ({ id: m[1], supported: true, reason: 'supported' })),
      }))
    const verified = rows.map((r) => ({ name: r.quantity.name, value: fmtNum(r.quantity), quote: r.quantity.source_quote }))
    const [take] = await triage({
      candidates: [{ id: '42855613', title: FIXTURE['42855613'].title, summary: src, verified, primary: findPrimary(rows, (r) => isRelationshipValidated(r.verdict), src) }],
    })
    expect(take.check).toEqual({ verdict: 'supported', reason: 'supported' })
    expect(extractStructured.mock.calls[0][0].content).toContain('does not name one')

    const secondary = [row(single({ name: 'Secondary outcome: major bleeding', value: 0.72, ci_low: 0.65, ci_high: 0.81, unit: 'RR', source_quote: 'RR 0.72; 95% CI 0.65-0.81' }), { flagged: false })]
    expect(findPrimary(secondary, () => true, src).state).toBe('unknown')
    expect(PRIMARY_UNKNOWN_REASON).toMatch(/Read the paper/)
  })
})
