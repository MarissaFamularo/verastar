// triage.test.js — the number guard on the digest prose. The finding may carry numbers,
// but ONLY numbers the verifier already proved for that paper; sanitizeRanking is the
// deterministic layer that enforces it (the prompt's HARD RULE is only persuasion). Same
// bias as verify.js: a grounded number that gets dropped is annoying; a fabricated number
// that renders is fatal — so every doubt resolves to the number-free form. Pure — fake
// rankings and verified rows, no model call.

import { describe, it, expect } from 'vitest'
import { allowedNumbers, numbersGrounded, stripNumbers, sanitizeRanking } from './triage.js'

// Verified rows as the callers build them: { name, value } where value is fmtNum output.
const V_HR = [{ name: 'hazard ratio', value: '0.84 (CI 0.61–1.16)' }]
const V_PCT = [{ name: 'mortality reduction', value: '8 %' }]
const V_FULL = [{ name: 'TcPO2 difference', value: '11.2 mmHg (CI 8.1–14.5), P<0.001' }]

const rk = (over = {}) => ({
  id: 'p1',
  score: 80,
  tier: 1,
  finding: 'Improved outcomes.',
  finding_plain: 'Improved outcomes.',
  relevance: 'Touches your CLTI perfusion work.',
  ...over,
})

describe('allowedNumbers — the verified set a finding may draw from', () => {
  it('tokenizes every number out of the fmtNum strings, CI bounds and p-values included', () => {
    expect(allowedNumbers(V_FULL)).toEqual([11.2, 8.1, 14.5, 0.001])
  })
  it('reads the CI en-dash as a range, never a negative second bound', () => {
    expect(allowedNumbers(V_HR)).toEqual([0.84, 0.61, 1.16])
  })
  it('is empty for a paper with no verified values (and for junk rows)', () => {
    expect(allowedNumbers([])).toEqual([])
    expect(allowedNumbers(undefined)).toEqual([])
    expect(allowedNumbers([{ name: 'x', value: null }])).toEqual([])
  })
})

describe('numbersGrounded — every digit in the prose must be a verified number', () => {
  it('passes a correctly cited value, percent, and p-value', () => {
    expect(numbersGrounded('reduced mortality by 8% versus placebo', allowedNumbers(V_PCT))).toBe(true)
    expect(numbersGrounded('HR 0.84 for the primary endpoint', allowedNumbers(V_HR))).toBe(true)
    expect(numbersGrounded('improved TcPO2 by 11.2 mmHg (P<0.001)', allowedNumbers(V_FULL))).toBe(true)
  })
  it('rejects a fabricated number even when other numbers are grounded', () => {
    expect(numbersGrounded('HR 0.84, a 16% relative reduction', allowedNumbers(V_HR))).toBe(false)
  })
  it('rejects a rounded or truncated verified value — representation equality, never rounding', () => {
    expect(numbersGrounded('HR of roughly 0.8', allowedNumbers(V_HR))).toBe(false)
    expect(numbersGrounded('difference of 11 mmHg', allowedNumbers(V_FULL))).toBe(false)
  })
  it('accepts representation variants of the same value (.84, 8.0, interpunct 0·84)', () => {
    expect(numbersGrounded('HR .84 overall', allowedNumbers(V_HR))).toBe(true)
    expect(numbersGrounded('an 8.0% reduction', allowedNumbers(V_PCT))).toBe(true)
    expect(numbersGrounded('HR 0·84 overall', allowedNumbers(V_HR))).toBe(true)
  })
  it('never lets a verified digit launder a longer number (8 inside 2008)', () => {
    expect(numbersGrounded('an 8% reduction since 2008', allowedNumbers(V_PCT))).toBe(false)
  })
  it('passes number-free prose regardless of the verified set', () => {
    expect(numbersGrounded('significantly reduced mortality versus placebo', [])).toBe(true)
    expect(numbersGrounded('', allowedNumbers(V_HR))).toBe(true)
  })
  it('nomenclature exemption: digits glued to a letter are names, not statistics', () => {
    expect(numbersGrounded('improved TcPO2 in the intervention arm', [])).toBe(true)
    expect(numbersGrounded('SF-36 scores improved after COVID-19', [])).toBe(true)
    expect(numbersGrounded('P2Y12 inhibitor adherence rose', [])).toBe(true)
  })
  it('but anything delimited stays gated — timeframes, folds, and "type 2"', () => {
    expect(numbersGrounded('lower 30-day mortality', [])).toBe(false)
    expect(numbersGrounded('a 3-fold increase in risk', [])).toBe(false)
    expect(numbersGrounded('in patients with type 2 diabetes', [])).toBe(false)
    expect(numbersGrounded('reduced by 8mmHg', [])).toBe(false) // glued unit: digit first, still gated
  })
})

describe('stripNumbers — the last-resort number-free form', () => {
  it('deletes values with their glued %, comparators, and signs', () => {
    expect(stripNumbers('reduced mortality by 8% versus placebo')).toBe('reduced mortality by versus placebo')
    expect(stripNumbers('significant (P<0.001) improvement')).toBe('significant (P) improvement')
    expect(stripNumbers('a difference of -0.4 points')).toBe('a difference of points')
  })
  it('leaves no digit behind, including ranges and thousands', () => {
    for (const s of ['CI 8.1–14.5', 'n=1,234 patients', 'HR 0·84', '30-day mortality']) {
      expect(stripNumbers(s)).not.toMatch(/\d/)
    }
  })
  it('is the identity on number-free prose', () => {
    const s = 'no meaningful difference between arms'
    expect(stripNumbers(s)).toBe(s)
  })
  it('preserves nomenclature — exactly what numbersGrounded exempts, nothing more', () => {
    expect(stripNumbers('improved TcPO2 in the arm')).toBe('improved TcPO2 in the arm')
    expect(stripNumbers('SF-36 scores after COVID-19')).toBe('SF-36 scores after COVID-19')
    expect(stripNumbers('a P2Y12 inhibitor')).toBe('a P2Y12 inhibitor')
  })
})

describe('sanitizeRanking — the guard every ranking passes before it can render', () => {
  it('keeps a finding whose numbers are all verified', () => {
    const out = sanitizeRanking(
      rk({ finding: 'Reduced mortality by 8% versus placebo.', finding_plain: 'Reduced mortality versus placebo.' }),
      V_PCT
    )
    expect(out.finding).toBe('Reduced mortality by 8% versus placebo.')
    expect(out).toEqual({ id: 'p1', score: 80, tier: 1, finding: out.finding, relevance: 'Touches your CLTI perfusion work.' })
  })

  it('drops a fabricated number to the number-free finding_plain', () => {
    const out = sanitizeRanking(
      rk({ finding: 'Reduced mortality by 12% versus placebo.', finding_plain: 'Significantly reduced mortality versus placebo.' }),
      V_HR // 12 is not among 0.84 / 0.61 / 1.16
    )
    expect(out.finding).toBe('Significantly reduced mortality versus placebo.')
  })

  it('a derived number (16% from HR 0.84) is fabrication and falls back', () => {
    const out = sanitizeRanking(
      rk({ finding: 'Cut the hazard by 16%.', finding_plain: 'Meaningfully cut the hazard.' }),
      V_HR
    )
    expect(out.finding).toBe('Meaningfully cut the hazard.')
  })

  it('paper with NO verified values: any digit falls back, number-free passes through', () => {
    const numeric = sanitizeRanking(rk({ finding: 'Enrolled 402 patients.', finding_plain: 'A large cohort.' }), [])
    expect(numeric.finding).toBe('A large cohort.')
    const clean = sanitizeRanking(rk({ finding: 'A narrative review of CLTI perfusion methods.' }), [])
    expect(clean.finding).toBe('A narrative review of CLTI perfusion methods.')
  })

  it('double violation (finding_plain also has digits) still renders zero unverified digits', () => {
    const out = sanitizeRanking(
      rk({ finding: 'Reduced mortality by 12%.', finding_plain: 'Reduced mortality by 12 points.' }),
      V_PCT
    )
    expect(out.finding).not.toMatch(/\d/)
    expect(out.finding).toContain('Reduced mortality')
  })

  it('empty finding_plain on a bad finding falls back to the hard strip — never a digit', () => {
    const out = sanitizeRanking(rk({ finding: 'Reduced mortality by 12%.', finding_plain: '' }), V_PCT)
    expect(out.finding).not.toMatch(/\d/)
  })

  it('relevance is number-free by contract — a sneaked digit is stripped', () => {
    const out = sanitizeRanking(rk({ relevance: 'Validates your 30-day readmission endpoint.' }), V_PCT)
    expect(out.relevance).not.toMatch(/\d/)
    const clean = sanitizeRanking(rk(), V_PCT)
    expect(clean.relevance).toBe('Touches your CLTI perfusion work.')
  })

  it('decimal edge: 0.84 in prose never satisfies a verified 0.847 (or vice versa)', () => {
    const out = sanitizeRanking(
      rk({ finding: 'HR 0.84 overall.', finding_plain: 'Lower hazard overall.' }),
      [{ name: 'hazard ratio', value: '0.847' }]
    )
    expect(out.finding).toBe('Lower hazard overall.')
  })

  it('missing fields degrade safely', () => {
    const out = sanitizeRanking({ id: 'x', score: 1, tier: 3 }, undefined)
    expect(out.finding).toBe('')
    expect(out.relevance).toBe('')
  })
})
