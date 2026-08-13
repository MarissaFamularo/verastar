// format.test.js — locks the fact-channel formatter. The two-channel rule
// (docs/VERIFICATION_SPEC.md) makes a rendered p-value operator part of the fact: the
// verifier accepts a magnitude-only match (claim 0.001 vs "P<0·001"), so printing "P="
// when the source said "P<" is a misstatement. The operator must come from the verified
// quote or not be asserted at all.

import { describe, it, expect } from 'vitest'
import { pOperator, fmtNum } from './format.js'

// Convenience: build a quantity.
const q = (fields) => ({ location_hint: '', ...fields })

describe('pOperator — derive the operator from the verified quote', () => {
  it('reads "<" through an interpunct decimal: P<0·001', () => {
    expect(pOperator(q({ p_value: 0.001, source_quote: 'significant (P<0·001)' }))).toBe('<')
  })

  it('reads "=" across whitespace and a representation difference: "P = .02" vs claim 0.02', () => {
    expect(pOperator(q({ p_value: 0.02, source_quote: 'P = .02' }))).toBe('=')
  })

  it('reads ">": P>0.05', () => {
    expect(pOperator(q({ p_value: 0.05, source_quote: 'not significant, P>0.05' }))).toBe('>')
  })

  it('reads "≤" and "≥", folding the slanted variants ⩽/⩾', () => {
    expect(pOperator(q({ p_value: 0.01, source_quote: 'P≤0.01' }))).toBe('≤')
    expect(pOperator(q({ p_value: 0.01, source_quote: 'P≥0.01' }))).toBe('≥')
    expect(pOperator(q({ p_value: 0.01, source_quote: 'P⩽0.01' }))).toBe('≤')
    expect(pOperator(q({ p_value: 0.01, source_quote: 'P⩾0.01' }))).toBe('≥')
  })

  it('reads ASCII "<=" / ">=" as ≤ / ≥ — never just the "=" tail', () => {
    // "P<=0.05" states ≤; rendering "=" would assert an equality the source never stated.
    expect(pOperator(q({ p_value: 0.05, source_quote: 'P<=0.05' }))).toBe('≤')
    expect(pOperator(q({ p_value: 0.05, source_quote: 'P>=0.05' }))).toBe('≥')
  })

  it('returns null when the quote states no operator', () => {
    expect(pOperator(q({ p_value: 0.02, source_quote: 'a p value of 0.02 was observed' }))).toBe(null)
  })

  it('matches the p_value token, not just any number in the quote', () => {
    // 0.84 and the CI bounds precede the p-value; only the 0.22 token's operator counts.
    const quote = 'hazard ratio was 0.84 (97.5% CI 0.61 to 1.16, P=0.22)'
    expect(pOperator(q({ p_value: 0.22, source_quote: quote }))).toBe('=')
  })

  it('first P-labelled matching token wins when the same number appears elsewhere', () => {
    expect(pOperator(q({ p_value: 0.05, source_quote: 'P<0.05 in A; P=0.05 in B' }))).toBe('<')
    expect(pOperator(q({ p_value: 0.05, source_quote: 'alpha of 0.05; P=0.05' }))).toBe('=')
  })

  it('returns null for a missing/empty quote or a quantity without p_value', () => {
    expect(pOperator(q({ p_value: 0.02, source_quote: '' }))).toBe(null)
    expect(pOperator(q({ p_value: 0.02 }))).toBe(null)
    expect(pOperator(q({ value: 0.84, source_quote: 'HR 0.84' }))).toBe(null)
    expect(pOperator(null)).toBe(null)
  })
})

describe('fmtNum — the fact-channel value string', () => {
  it('preserves printed significant figures from the verbatim quote', () => {
    const precise = q({
      value: 1,
      ci_low: 1,
      ci_high: 2.5,
      p_value: 0,
      source_quote: 'ratio 1.0 (95% CI 1.00–2.50; P=0.00)',
    })
    expect(fmtNum(precise)).toBe('1.0 (CI 1.00–2.50), P=0.00')
  })

  it('preserves source decimal marks and thousands separators', () => {
    expect(fmtNum(q({ value: 0.84, source_quote: 'HR 0·84' }))).toBe('0·84')
    expect(fmtNum(q({ value: 502157, source_quote: 'cohort of 502,157 participants' }))).toBe('502,157')
    expect(fmtNum(q({ value: -0.4, source_quote: 'difference −0.40' }))).toBe('−0.40')
  })

  it('renders complete reported ranges with source precision and separator', () => {
    expect(fmtNum(q({
      value: null,
      range_low: 0.823,
      range_high: 0.855,
      source_quote: 'mean posterior probability 0.823–0.855',
    }))).toBe('0.823–0.855')
    expect(fmtNum(q({
      value: null,
      range_low: 3.43,
      range_high: 3.52,
      unit: 'HR',
      source_quote: 'adjusted Cox models HR 3.43–3.52',
    }))).toBe('3.43–3.52 HR')
    expect(fmtNum(q({
      value: null,
      range_low: 1,
      range_high: 2.5,
      source_quote: 'values ranged from 1.00 to 2.50',
    }))).toBe('1.00 to 2.50')
  })

  it('uses the P-labelled occurrence when its value duplicates the estimate', () => {
    const duplicate = q({ value: 0.05, p_value: 0.05, source_quote: 'difference 0.05; P=0.050' })
    expect(fmtNum(duplicate)).toBe('0.05, P=0.050')
  })

  it('renders a change directionally rather than as a range', () => {
    expect(fmtNum(q({
      quantity_type: 'change', first_value: 2.4, second_value: 9.5, unit: '%',
      source_quote: 'DCD HTx increased from 2.4% to 9.5%',
    }))).toBe('from 2.4 to 9.5 %')
  })

  it('renders comparison labels beside the correct values', () => {
    expect(fmtNum(q({
      quantity_type: 'comparison',
      first_label: 'Period 2', first_value: 24,
      second_label: 'period 1', second_value: 40,
      unit: 'days',
      source_quote: 'Period 2 had 24 versus 40 days in period 1',
    }))).toBe('Period 2: 24 versus period 1: 40 days')
  })

  it('renders the quote\'s operator, never an invented "="', () => {
    expect(fmtNum(q({ value: 0.001, p_value: 0.001, source_quote: '(P<0·001)' }))).toBe('0·001, P<0·001')
    expect(fmtNum(q({ value: 0.05, p_value: 0.05, source_quote: 'P>0.05' }))).toBe('0.05, P>0.05')
    expect(fmtNum(q({ value: 0.01, p_value: 0.01, source_quote: 'P≤0.01' }))).toBe('0.01, P≤0.01')
    expect(fmtNum(q({ value: 0.05, p_value: 0.05, source_quote: 'P<=0.05' }))).toBe('0.05, P≤0.05')
  })

  it('renders "=" ONLY when the quote states it', () => {
    expect(fmtNum(q({ value: 0.02, p_value: 0.02, source_quote: 'P = .02' }))).toBe('.02, P=.02')
  })

  it('renders operator-free when the quote states none', () => {
    expect(fmtNum(q({ value: 0.02, p_value: 0.02, source_quote: 'a p value of 0.02 was observed' }))).toBe(
      '0.02, P 0.02',
    )
  })

  it('leaves quantities without a p_value unchanged', () => {
    expect(fmtNum(q({ value: 0.84, ci_low: 0.61, ci_high: 1.16, source_quote: 'HR 0.84' }))).toBe(
      '0.84 (CI 0.61–1.16)',
    )
    expect(fmtNum(q({ value: 84, unit: '%' }))).toBe('84 %')
    expect(fmtNum(q({ value: null }))).toBe('')
  })

  it('full string: value + unit + CI + p', () => {
    const full = q({
      value: 11.2,
      unit: 'mmHg',
      ci_low: 8.1,
      ci_high: 14.5,
      p_value: 0.001,
      source_quote: 'difference 11.2 mmHg (95% CI 8.1–14.5; P<0.001)',
    })
    expect(fmtNum(full)).toBe('11.2 mmHg (CI 8.1–14.5), P<0.001')
    const noOp = q({
      value: 0.84,
      ci_low: 0.61,
      ci_high: 1.16,
      p_value: 0.22,
      source_quote: 'hazard ratio 0.84 (0.61 to 1.16); p value 0.22',
    })
    expect(fmtNum(noOp)).toBe('0.84 (CI 0.61–1.16), P 0.22')
  })
})
