// misboundCi.test.js — regressions from the first live single-paper extraction
// (2026-10-10). Two saved-row shapes the extraction contract forbids but a model can still
// emit, and that saved evidence may already hold:
//
//   1. A percentage comparison carrying the confidence interval of a hazard ratio printed
//      later in the same quote. The formatter rendered it as uncertainty around the
//      percentages: "6.7% versus 5.4% (CI 0.81–1.96)".
//   2. A stand-alone P value with no estimate (quantity_type single, value null).
//
// Rows are shaped field-for-field like the live output; quotes are synthetic. Pure — no
// model call.

import { describe, it, expect } from 'vitest'
import { fmtNum, ciBelongsToEstimate } from './format.js'
import { buildBadgeReport } from './feedback.js'
import { linkFindingNumbers } from './claimCheck.js'
import { allowedNumbers } from '../pipeline/triage.js'
import { dropUnprovenLabels } from '../pipeline/extract.js'
import { verify, TIERS, TIGHTENED_TIERS } from '../pipeline/verify.js'

const row = (fields) => ({
  name: 'result',
  quantity_type: 'single',
  value: null,
  range_low: null,
  range_high: null,
  first_label: null,
  first_value: null,
  second_label: null,
  second_value: null,
  unit: null,
  ci_low: null,
  ci_high: null,
  p_value: null,
  source_quote: '',
  location_hint: 'Results',
  ...fields,
})

// Live-output-shaped rows 7 and 8: the CI belongs to the hazard ratio in the quote.
const SYMPTOMATIC = row({
  name: 'Periprocedural primary end point in symptomatic patients, stenting vs endarterectomy',
  quantity_type: 'comparison',
  first_value: 6.7,
  second_value: 5.4,
  unit: '%',
  ci_low: 0.81,
  ci_high: 1.96,
  source_quote: 'in the symptomatic subgroup (6.7% vs. 5.4%; hazard ratio for stenting, 1.26; 95% CI, 0.81 to 1.96)',
})
const ASYMPTOMATIC = row({
  name: 'Periprocedural primary end point in asymptomatic patients, stenting vs endarterectomy',
  quantity_type: 'comparison',
  first_value: 3.5,
  second_value: 3.6,
  unit: '%',
  ci_low: 0.55,
  ci_high: 1.86,
  source_quote: 'in the asymptomatic subgroup (3.5% vs. 3.6%; hazard ratio, 1.02; 95% CI, 0.55 to 1.86)',
})
// A different paper's shape, so nothing here can pass by matching one trial's wording:
// word unit, odds ratio, bracketed interval, and a P value that stays on the row.
const OPERATIVE_TIME = row({
  name: 'Operative time, robotic vs open',
  quantity_type: 'comparison',
  first_value: 212,
  second_value: 187,
  unit: 'minutes',
  ci_low: 1.12,
  ci_high: 2.4,
  p_value: 0.01,
  source_quote: 'Operative time was longer with the robotic approach (212 vs 187 minutes; odds ratio for conversion 1.64 [95% CI 1.12-2.40]; P = 0.01)',
})
const SOURCE = [
  'Outcomes were assessed at 30 days.',
  `Event rates were similar ${SYMPTOMATIC.source_quote} and ${ASYMPTOMATIC.source_quote}.`,
  `${OPERATIVE_TIME.source_quote}.`,
  'An interaction between age and treatment efficacy was detected (P = 0.02).',
].join(' ')

describe('a confidence interval is rendered only around the estimate it describes', () => {
  it('does not append a hazard ratio\'s CI to a percentage comparison', () => {
    expect(fmtNum(SYMPTOMATIC)).toBe('6.7% versus 5.4%')
    expect(fmtNum(ASYMPTOMATIC)).toBe('3.5% versus 3.6%')
  })

  it('holds for a different pair, measure and CI grammar, and keeps the row\'s P value', () => {
    expect(fmtNum(OPERATIVE_TIME)).toBe('212 versus 187 minutes, P=0.01')
  })

  it('holds for labeled comparisons, changes and reported ranges', () => {
    expect(fmtNum(row({
      quantity_type: 'comparison', first_label: 'stenting', first_value: 6.7, second_label: 'endarterectomy', second_value: 5.4, unit: '%', ci_low: 0.81, ci_high: 1.96,
      source_quote: 'stenting 6.7% and endarterectomy 5.4% (hazard ratio 1.26; 95% CI, 0.81 to 1.96)',
    }))).toBe('stenting: 6.7% versus endarterectomy: 5.4%')
    expect(fmtNum(row({
      quantity_type: 'change', first_value: 41, second_value: 29, unit: 'mmHg', ci_low: 8, ci_high: 16,
      source_quote: 'fell from 41 to 29 mmHg (mean difference 12; 95% CI 8 to 16)',
    }))).toBe('from 41 to 29 mmHg')
    expect(fmtNum(row({
      quantity_type: 'range', range_low: 1.2, range_high: 1.9, unit: 'HR', ci_low: 1.05, ci_high: 2.4,
      source_quote: 'hazard ratios ranged from 1.2 to 1.9 across models (widest 95% CI 1.05 to 2.4)',
    }))).toBe('1.2 to 1.9 HR')
  })

  it('keeps the CI of a single estimate, with and without a declared type', () => {
    const hr = row({ value: 0.07, unit: 'hazard ratio', ci_low: 0.02, ci_high: 0.18, source_quote: 'hazard ratio, 0.07; 95% CI, 0.02 to 0.18' })
    expect(fmtNum(hr)).toBe('0.07 hazard ratio (CI 0.02–0.18)')
    // Legacy saved rows have no quantity_type.
    expect(fmtNum({ value: 0.84, ci_low: 0.61, ci_high: 1.16, p_value: 0.22, source_quote: 'HR 0.84 (95% CI 0.61–1.16, P=0.22)' })).toBe('0.84 (CI 0.61–1.16), P=0.22')
  })

  it('leaves ordinary pair formatting unchanged', () => {
    expect(fmtNum(row({ quantity_type: 'comparison', first_value: 4.1, second_value: 2.3, unit: '%', p_value: 0.01, source_quote: 'stroke (4.1% vs. 2.3%, P = 0.01)' }))).toBe('4.1% versus 2.3%, P=0.01')
  })

  it('exposes the policy as a predicate and never edits the row', () => {
    const before = JSON.stringify(SYMPTOMATIC)
    expect(ciBelongsToEstimate(SYMPTOMATIC)).toBe(false)
    expect(ciBelongsToEstimate(row({ value: 1.5, ci_low: 1.05, ci_high: 2.15 }))).toBe(true)
    fmtNum(SYMPTOMATIC)
    expect(JSON.stringify(SYMPTOMATIC)).toBe(before)
  })
})

describe('the misbound CI is not laundered into a verified tier', () => {
  it('saved rows stay source-located and withheld, with the receipt intact', () => {
    for (const saved of [SYMPTOMATIC, ASYMPTOMATIC, OPERATIVE_TIME]) {
      const quantity = dropUnprovenLabels(saved)
      const verdict = verify(quantity, SOURCE, { sourceTier: 'full_text' })
      expect(verdict.tier).toBe(TIERS.LOCATED)
      expect(TIGHTENED_TIERS).not.toContain(verdict.tier)
      expect(verdict.flagged).toBe(true)
      expect(verdict.relationshipValidated).toBe(false)
      expect(quantity.source_quote).toBe(saved.source_quote)
      // The pipeline still verifies the row as extracted: the CI fields are not stripped.
      expect(quantity.ci_low).toBe(saved.ci_low)
      expect(quantity.ci_high).toBe(saved.ci_high)
    }
  })
})

describe('every surface that formats a saved row drops the misbound CI', () => {
  it('writer input: the CI bounds are not numbers a finding may carry', () => {
    const allowed = allowedNumbers([{ name: SYMPTOMATIC.name, value: fmtNum(SYMPTOMATIC) }])
    expect(allowed).toEqual([6.7, 5.4])
  })

  it('finding links: a CI bound in prose is not linked to the percentage row', () => {
    const segments = linkFindingNumbers('Rates were 6.7% and 5.4% (0.81 to 1.96).', [{ quantity: SYMPTOMATIC }])
    expect(segments.filter((s) => s.row).map((s) => s.text)).toEqual(['6.7', '5.4'])
  })

  it('badge report: the value as shown omits the CI, the raw fields keep it', () => {
    const report = buildBadgeReport({ surface: 'digest', pmid: '1', quantity: SYMPTOMATIC, verdict: verify(SYMPTOMATIC, SOURCE), reportId: 'r1' })
    expect(report.value).toBe('6.7% versus 5.4%')
    expect(report.quantity.ci_low).toBe(0.81)
    expect(report.quantity.ci_high).toBe(1.96)
  })
})

describe('a stand-alone P value is explicitly labelled', () => {
  // Live-output-shaped row 11.
  const P_ONLY = row({
    name: 'Treatment-by-age interaction on primary end point',
    p_value: 0.02,
    source_quote: 'An interaction between age and treatment efficacy was detected (P = 0.02)',
  })

  it('is flagged for its shape and withheld, though the P is in the source', () => {
    const verdict = verify(P_ONLY, SOURCE, { sourceTier: 'full_text' })
    expect(verdict.found).toBe(true)
    expect(verdict.badNums).toEqual([])
    expect(verdict.tier).toBe(TIERS.FLAGGED)
    expect(verdict.flagged).toBe(true)
    expect(verdict.shapeError).toMatch(/exactly one declared shape/)
  })

  it('renders a P label rather than promoting P to an effect estimate', () => {
    expect(fmtNum(P_ONLY)).toBe('P=0.02')
    expect(fmtNum({ p_value: 0.02, source_quote: P_ONLY.source_quote })).toBe('P=0.02')
  })

  it('a P value printed with its estimate is still verified and shown', () => {
    const src = 'Stroke or death at four years favored endarterectomy (hazard ratio, 1.50; 95% CI, 1.05 to 2.15; P = 0.03).'
    const q = row({ name: 'Four-year stroke or death', value: 1.5, unit: 'hazard ratio', ci_low: 1.05, ci_high: 2.15, p_value: 0.03, source_quote: 'hazard ratio, 1.50; 95% CI, 1.05 to 2.15; P = 0.03' })
    expect(verify(q, src, { sourceTier: 'full_text' }).tier).toBe(TIERS.ESTIMATE)
    expect(fmtNum(q)).toBe('1.50 hazard ratio (CI 1.05–2.15), P=0.03')
  })
})
