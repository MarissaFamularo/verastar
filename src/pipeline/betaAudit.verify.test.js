// Pre-beta adversarial audit of the deterministic verifier. Every case asserts the SAFE
// outcome (not a verified tier / flagged). A FAILING case is a real false-verify finding.
// Groups: [FINDING-n] fixed bugs (assert the safe outcome); [design-limit-n] documented limits that
// still verify today (assertions pin CURRENT behaviour; flip them if the design changes); [guard].
import { describe, it, expect } from 'vitest'
import { verify, TIERS } from './verify.js'

const base = { quantity_type: 'single', range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, ci_low: null, ci_high: null, p_value: null, unit: null, location_hint: 'Results' }
const q = (fields) => ({ ...base, name: 'Result', ...fields })
const VERIFIED = new Set(['verified-registry', 'verified-full-text', 'abstract-only', 'verified-user-text', 'verified-estimate', 'verified-comparison', 'verified-proportion', 'verified-heterogeneity'])
const run = (quantity, src, opts = { sourceTier: 'full_text' }) => verify(quantity, src, opts)
const safe = (quantity, src, opts) => {
  const v = run(quantity, src, opts)
  return !VERIFIED.has(v.tier) && v.flagged === true && v.relationshipValidated === false
}
const tierOf = (quantity, src) => run(quantity, src).tier

describe('quote sliced mid-token: validators read the SLICE, not the source', () => {
  it('[FINDING-1] left-truncated comparison: source 15% vs 7%, quote starts at "5%"', () => {
    const src = 'Mortality was 15% vs 7% in 5 patients.'
    const quote = '5% vs 7% in 5 patients'
    expect(src.includes(quote)).toBe(true)
    expect(safe(q({ quantity_type: 'comparison', value: null, unit: '%', first_value: 5, second_value: 7, source_quote: quote }), src)).toBe(true)
  })
  it('[FINDING-1b] left-truncated comparison drops a minus sign: source -5 vs 7', () => {
    const src = 'Change was -5 vs 7 (5 patients).'
    const quote = '5 vs 7 (5 patients)'
    expect(safe(q({ quantity_type: 'comparison', value: null, first_value: 5, second_value: 7, source_quote: quote }), src)).toBe(true)
  })
  it('[FINDING-2] right-truncated comparison: source 9% vs 9.5%, quote ends at "9"', () => {
    const src = 'Rates were 9% vs 9.5%.'
    const quote = '9% vs 9'
    expect(safe(q({ quantity_type: 'comparison', value: null, first_value: 9, second_value: 9, source_quote: quote }), src)).toBe(true)
  })
  it('[FINDING-3] right-truncated estimate: CI high 1.57 printed, quote ends "1.5" borrowing the value token', () => {
    const src = 'The HR was 1.5 (95% CI 0.8-1.57) overall.'
    const quote = 'HR was 1.5 (95% CI 0.8-1.5'
    expect(safe(q({ unit: 'HR', value: 1.5, ci_low: 0.8, ci_high: 1.5, source_quote: quote }), src)).toBe(true)
  })
  it('[guard] right-truncated estimate that cannot borrow a token is flagged', () => {
    const src = 'The HR was 1.2 (95% CI 0.8-1.57) overall.'
    expect(safe(q({ unit: 'HR', value: 1.2, ci_low: 0.8, ci_high: 1.5, source_quote: 'HR was 1.2 (95% CI 0.8-1.5' }), src)).toBe(true)
  })
  it('[FINDING-4] bare "or" opens the quote: probability 0.10 read as an odds ratio', () => {
    const src = 'The risk was 10% or 0.10 (95% CI 0.05-0.15) in this cohort.'
    const quote = 'or 0.10 (95% CI 0.05-0.15)'
    expect(safe(q({ name: 'Odds ratio', unit: 'OR', value: 0.1, ci_low: 0.05, ci_high: 0.15, source_quote: quote }), src)).toBe(true)
  })
  it('[guard] bare "or" mid-quote is not an odds ratio', () => {
    const src = 'The risk was 10% or 0.10 (95% CI 0.05-0.15) in this cohort.'
    expect(safe(q({ name: 'Odds ratio', unit: 'OR', value: 0.1, ci_low: 0.05, ci_high: 0.15, source_quote: 'risk was 10% or 0.10 (95% CI 0.05-0.15)' }), src)).toBe(true)
  })
  it('[guard] 0.02 in 0.028 and 1.2 in 11.2 never credit', () => {
    expect(safe(q({ value: 0.02, source_quote: 'p = 0.02' }), 'The value was p = 0.028 overall.')).toBe(true)
    expect(safe(q({ value: 1.2, source_quote: 'was 1.2' }), 'The score was 11.2 overall.')).toBe(true)
  })
})

describe('normalization turns a different printed number into the claimed one', () => {
  it('[FINDING-5] superscript exponent 10² is folded to 102 and verifies as a value of 102', () => {
    const src = 'Titer was 10² copies.'
    expect(safe(q({ name: 'Titer', unit: 'copies', value: 102, source_quote: 'Titer was 10² copies.' }), src)).toBe(true)
  })
  it('[FINDING-6] European decimal 0,847 is read as the thousands-grouped 847', () => {
    const src = 'Albumin was 0,847 mg.'
    expect(safe(q({ name: 'Albumin', unit: 'mg', value: 847, source_quote: 'Albumin was 0,847 mg.' }), src)).toBe(true)
  })
  it('[FINDING-6b] European decimal P 0,001 is read as P = 1', () => {
    const src = 'Mortality was 36% vs 26%, P = 0,001.'
    expect(safe(q({ quantity_type: 'comparison', value: null, unit: '%', first_value: 36, second_value: 26, p_value: 1, source_quote: 'Mortality was 36% vs 26%, P = 0,001.' }), src)).toBe(true)
  })
  it('[FINDING-6c] fraction 1½ is folded to "11⁄2" so a comparison credits 11', () => {
    const src = 'Stay was 5 vs 1½ days.'
    expect(safe(q({ quantity_type: 'comparison', value: null, first_value: 5, second_value: 11, source_quote: 'Stay was 5 vs 1½ days.' }), src)).toBe(true)
  })
  it('[guard] full-width digits fold to the honest ASCII value (verifies only the true value)', () => {
    expect(tierOf(q({ name: 'Mortality', unit: '%', value: 5, source_quote: 'Mortality was ５%.' }), 'Mortality was ５%.')).toBe(TIERS.FULL_TEXT)
    expect(safe(q({ name: 'Mortality', unit: '%', value: 50, source_quote: 'Mortality was ５%.' }), 'Mortality was ５%.')).toBe(true)
  })
  it('[guard] thousands separator: 1,234 verifies as 1234 only', () => {
    expect(safe(q({ name: 'Count', unit: 'cells', value: 234, source_quote: 'Count was 1,234 cells.' }), 'Count was 1,234 cells.')).toBe(true)
  })
  it('[guard] scientific notation: 1.5 x 10^-3 does not verify 1.5', () => {
    expect(safe(q({ name: 'Titer', unit: 'mg', value: 1.5, source_quote: 'Titer was 1.5 x 10^-3 mg.' }), 'Titer was 1.5 x 10^-3 mg.')).toBe(true)
  })
  it('[guard] minus sign: source -0.4 does not verify +0.4; unicode minus kept negative', () => {
    expect(safe(q({ name: 'Change', unit: 'mg', value: 0.4, source_quote: 'Change was −0.4 mg.' }), 'Change was −0.4 mg.')).toBe(true)
    expect(tierOf(q({ name: 'Change', unit: 'mg', value: -0.4, source_quote: 'Change was −0.4 mg.' }), 'Change was −0.4 mg.')).toBe(TIERS.FULL_TEXT)
  })
  it('[guard] range dash is not a minus: CI 1.26-2.90 cannot yield -2.9', () => {
    const src = 'The HR was 1.5 (95% CI 1.26-2.90).'
    expect(safe(q({ unit: 'HR', value: 1.5, ci_low: 1.26, ci_high: -2.9, source_quote: 'HR was 1.5 (95% CI 1.26-2.90)' }), src)).toBe(true)
  })
  it('[guard] fuzzy alnum collapse of 1.2 and 12 never verifies', () => {
    const src = 'The score was 1.2 overall in this cohort.'
    expect(safe(q({ name: 'Score', unit: 'points', value: 12, source_quote: 'the score was 12 overall in this cohort' }), src)).toBe(true)
    expect(safe(q({ name: 'Score', unit: 'points', value: 1.2, source_quote: 'the score was 12 overall in this cohort' }), src)).toBe(true)
  })
})

describe('comparison grammar operands', () => {
  it('[design-limit-7] SD printed as "SD x" becomes the left operand: 61 years, SD 8.2 vs 59', () => {
    const src = 'Age was 61 years, SD 8.2 vs 59 years.'
    expect(safe(q({ quantity_type: 'comparison', value: null, unit: 'years', first_value: 8.2, second_value: 59, source_quote: 'Age was 61 years, SD 8.2 vs 59 years' }), src)).toBe(false)
  })
  it('[design-limit-8] "10 of 20 vs 7 of 20": denominator 10 taken as the group value', () => {
    const src = 'Events occurred in 5 of 10 vs 7 of 10 patients.'
    expect(safe(q({ quantity_type: 'comparison', value: null, first_value: 10, second_value: 7, source_quote: 'Events occurred in 5 of 10 vs 7 of 10 patients.' }), src)).toBe(false)
  })
  it('[design-limit-9] right operand is the start of a range: "vs 7-9"', () => {
    const src = 'Median stay was 5 vs 7-9 days.'
    expect(safe(q({ quantity_type: 'comparison', value: null, first_value: 5, second_value: 7, source_quote: 'Median stay was 5 vs 7-9 days.' }), src)).toBe(false)
  })
  it('[design-limit-10] years are not group values: "enrolled in 2019 vs 2020"', () => {
    const src = 'Patients were enrolled in 2019 vs 2020.'
    expect(safe(q({ quantity_type: 'comparison', value: null, first_value: 2019, second_value: 2020, source_quote: 'Patients were enrolled in 2019 vs 2020' }), src)).toBe(false)
  })
  it('[design-limit-11] supplied group labels are swapped relative to the sentence (vs grammar ignores labels)', () => {
    const src = 'Between placebo and drug, mortality was 5% vs 7%.'
    expect(safe(q({ quantity_type: 'comparison', value: null, unit: '%', first_label: 'drug', second_label: 'placebo', first_value: 5, second_value: 7, source_quote: 'Between placebo and drug, mortality was 5% vs 7%' }), src)).toBe(false)
  })
  it('[guard] swapped values fail', () => {
    const src = 'Mortality was 36% vs 26%, P = 0.035.'
    expect(safe(q({ quantity_type: 'comparison', value: null, unit: '%', first_value: 26, second_value: 36, source_quote: src }), src)).toBe(true)
  })
  it('[guard] P from a later clause is not bound', () => {
    const src = 'Mortality was 36% vs 26%, and the stroke rate differed, P = 0.035.'
    expect(safe(q({ quantity_type: 'comparison', value: null, unit: '%', first_value: 36, second_value: 26, p_value: 0.035, source_quote: src }), src)).toBe(true)
  })
  it('[guard] unit mismatch on the right operand', () => {
    const src = 'Stay was 5 vs 7 days.'
    expect(safe(q({ quantity_type: 'comparison', value: null, unit: 'hours', first_value: 5, second_value: 7, source_quote: src }), src)).toBe(true)
  })
})

describe('"and" pair cue is trivially satisfiable', () => {
  it('[FINDING-12] two ENDPOINTS with an unrelated cue word before them verify as a group comparison', () => {
    const src = 'Event rates were higher than expected, with mortality (5%) and stroke (3%).'
    expect(safe(q({ quantity_type: 'comparison', value: null, unit: '%', first_label: 'mortality', second_label: 'stroke', first_value: 5, second_value: 3, source_quote: src }), src)).toBe(true)
  })
})

describe('sentence grammar (endpoint-validated tiers)', () => {
  it('[FINDING-13] overlapping arm labels: second label swallows a third arm', () => {
    const src = 'Dose was 5 mg in men and 6 mg in women and 7 mg in children.'
    // first = "men and 6 mg in women" (5 mg) is a mislabel of the men-only value
    expect(safe(q({ quantity_type: 'comparison', name: 'Dose', unit: 'mg', value: null, first_label: 'men and 6 mg in women', second_label: 'children', first_value: 5, second_value: 7, source_quote: src }), src)).toBe(true)
  })
  it('[guard] unit prefix: mg vs mg/dL', () => {
    expect(safe(q({ name: 'Dose', unit: 'mg', value: 5, source_quote: 'Dose was 5 mg/dL.' }), 'Dose was 5 mg/dL.')).toBe(true)
    expect(safe(q({ name: 'Dose', unit: 'mg', value: 5, source_quote: 'Dose was 5 mg' }), 'Dose was 5 mg/dL.')).toBe(true)
  })
  it('[guard] clause-internal prefix, negation, hypothetical stay unresolved', () => {
    expect(safe(q({ name: 'Mortality', unit: '%', value: 5, source_quote: 'Mortality was 5%' }), 'We did not find that mortality was 5%.')).toBe(true)
    expect(safe(q({ name: 'Mortality', unit: '%', value: 5, source_quote: 'Mortality was 5%.' }), 'Results: Mortality was 5%.')).toBe(true)
    expect(safe(q({ name: 'Mortality', unit: '%', value: 5, source_quote: 'Mortality was 5%' }), 'Mortality was 5% in the placebo arm.')).toBe(true)
  })
  it('[guard] repeated sentence is refused', () => {
    const s = 'Mortality was 5%.'
    expect(safe(q({ name: 'Mortality', unit: '%', value: 5, source_quote: s }), `${s} ${s}`)).toBe(true)
  })
  it('[guard] quote spans two sentences', () => {
    const src = 'Mortality was 5%. Stroke was 3%.'
    expect(safe(q({ name: 'Mortality', unit: '%', value: 3, source_quote: src }), src)).toBe(true)
  })
  it('[guard] n of N where N < n', () => {
    const src = 'Crossing was achieved in 120 of 117 CTOs (102.6%).'
    expect(safe(q({ unit: '%', value: 102.6, source_quote: src }), src)).toBe(true)
  })
  it('[guard] proportion with a truncated percentage is not recomputed to a match', () => {
    const src = 'Crossing was achieved in 109 of 117 CTOs (93.1%).'
    expect(safe(q({ unit: '%', value: 93.1, source_quote: src }), src)).toBe(true)
  })
  it('[guard] diagnostic pair: other test name, prefix, negation', () => {
    expect(safe(q({ name: 'Sensitivity of nHEART', unit: '%', value: 97.1, source_quote: 'pHEART achieved sensitivity of 97.1% and specificity of 53.8%.' }), 'pHEART achieved sensitivity of 97.1% and specificity of 53.8%.')).toBe(true)
    const src = 'The claim was false: nHEART achieved sensitivity of 97.1% and specificity of 53.8%.'
    expect(safe(q({ name: 'Sensitivity of nHEART', unit: '%', value: 97.1, source_quote: src }), src)).toBe(true)
  })
})

describe('estimate / heterogeneity context', () => {
  it('[FINDING-14] heterogeneity P that is not a result: "Cochran Q p = 1.2e-5" binds P = 1.2', () => {
    const src = 'Heterogeneity: I² = 89.0%; Cochran Q-test p = 1.2e-5.'
    expect(safe(q({ name: 'I² heterogeneity', unit: '%', value: 89, p_value: 1.2, source_quote: src }), src)).toBe(true)
  })
  it('[design-limit-15] I² quoted as a decision threshold in Methods verifies as a result', () => {
    const src = 'Random effects models were used if heterogeneity was substantial (I² = 50%).'
    expect(safe(q({ name: 'I² heterogeneity', unit: '%', value: 50, source_quote: src }), src)).toBe(false)
  })
  it('[design-limit-16] ratio name on the row is a different family and unit is omitted (name never compared)', () => {
    const src = 'The hazard ratio for death was 0.72 (95% CI 0.55-0.94).'
    expect(safe(q({ name: 'Odds ratio for stroke', unit: null, value: 0.72, ci_low: 0.55, ci_high: 0.94, source_quote: src }), src)).toBe(false)
  })
  it('[design-limit-17] assumed effect in a sample-size sentence verifies as a result', () => {
    const src = 'Assuming a hazard ratio of 0.70 (95% CI 0.50-0.90) from prior work, the trial enrolled 400 patients.'
    expect(safe(q({ unit: 'HR', value: 0.7, ci_low: 0.5, ci_high: 0.9, source_quote: 'hazard ratio of 0.70 (95% CI 0.50-0.90)' }), src)).toBe(false)
  })
  it('[guard] heterogeneity: pooled P is not the heterogeneity P', () => {
    const src = 'Pooled HR 1.81 (P = 0.04); I² = 89.0%; Cochran Q-test p = 0.003.'
    expect(safe(q({ name: 'I² heterogeneity', unit: '%', value: 89, p_value: 0.04, source_quote: src }), src)).toBe(true)
  })
  it('[guard] tau-squared is not I²', () => {
    const src = 'Between-study variance τ² = 0.18 and k = 2.'
    expect(safe(q({ name: 'I² heterogeneity', unit: '%', value: 0.18, source_quote: src }), src)).toBe(true)
  })
  it('[guard] 95 from "95% CI" does not verify a value of 95', () => {
    const src = 'The HR was 1.2 (95% CI 0.8-1.5).'
    expect(safe(q({ unit: 'HR', value: 95, ci_low: 0.8, ci_high: 1.5, source_quote: 'HR was 1.2 (95% CI 0.8-1.5)' }), src)).toBe(true)
  })
  it('[guard] swapped CI bounds, unit mismatch, signed CI', () => {
    const src = 'The HR was 1.2 (95% CI 0.8-1.5).'
    expect(safe(q({ unit: 'HR', value: 1.2, ci_low: 1.5, ci_high: 0.8, source_quote: 'HR was 1.2 (95% CI 0.8-1.5)' }), src)).toBe(true)
    expect(safe(q({ unit: 'mg', value: 1.2, ci_low: 0.8, ci_high: 1.5, source_quote: 'HR was 1.2 (95% CI 0.8-1.5)' }), src)).toBe(true)
    expect(safe(q({ unit: 'HR', value: 1.2, ci_low: 0.8, ci_high: 1.5, source_quote: 'HR -1.2 (95% CI -0.8 to 1.5)' }), 'HR -1.2 (95% CI -0.8 to 1.5)')).toBe(true)
  })
  it('[guard] P from a neighbouring clause is not bound', () => {
    const src = 'The HR was 1.2 (95% CI 0.8-1.5), and the OR was 2.0, P = 0.04.'
    expect(safe(q({ unit: 'HR', value: 1.2, ci_low: 0.8, ci_high: 1.5, p_value: 0.04, source_quote: src }), src)).toBe(true)
  })
  it('[guard] two estimates in one quote cannot trade values', () => {
    const src = 'HR 1.2 (95% CI 0.8-1.5) and HR 2.0 (95% CI 1.1-3.0).'
    expect(safe(q({ unit: 'HR', value: 2.0, ci_low: 0.8, ci_high: 1.5, source_quote: src }), src)).toBe(true)
  })
  it('[guard] bracket interval: citation / integer range / mg unit not a CI', () => {
    expect(safe(q({ unit: 'HR', value: 1, ci_low: 12, ci_high: 34, source_quote: 'HR 1 [12-34]' }), 'HR 1 [12-34]')).toBe(true)
    expect(safe(q({ unit: 'OR', value: 2.5, ci_low: 1.5, ci_high: 3.5, source_quote: 'OR 2.5 (1.5-3.5 mg)' }), 'OR 2.5 (1.5-3.5 mg)')).toBe(true)
  })
})

describe('quote location', () => {
  it('[guard] quote of a single digit inside a year', () => {
    expect(safe(q({ name: 'Year', value: 8, source_quote: '8' }), 'Recruitment ended in 2008.')).toBe(true)
  })
  it('[guard] page / figure / reference numbers do not verify results', () => {
    expect(safe(q({ name: 'Mortality', unit: '%', value: 12, source_quote: 'Mortality was see Figure 12' }), 'Mortality was 5% (see Figure 12).')).toBe(true)
  })
  it('[guard] empty and whitespace quotes', () => {
    expect(safe(q({ value: 5, source_quote: '' }), 'x was 5')).toBe(true)
    expect(safe(q({ value: 5, source_quote: '   ' }), 'x was 5')).toBe(true)
  })
  it('[guard] table-only match never earns a relationship tier', () => {
    const v = run(q({ name: 'Mortality', unit: '%', value: 5, location_hint: 'Table 2', source_quote: 'Mortality was 5%.' }), { text: '', tables: 'Mortality was 5%.' })
    expect(VERIFIED.has(v.tier)).toBe(false)
  })
  it('[guard] registry tier needs full identity', () => {
    const src = 'Mortality was 5%.'
    const v = run(q({ name: 'Mortality', unit: '%', value: 5, source_quote: src }), src, { sourceTier: 'full_text', registry: [{ measure: 'Mortality', value: 5 }] })
    expect(v.tier).not.toBe(TIERS.REGISTRY)
  })
  it('[guard] number words never verify', () => {
    const src = 'Mortality was five percent.'
    expect(safe(q({ name: 'Mortality', unit: '%', value: 5, source_quote: src }), src)).toBe(true)
  })
})

describe('robustness: malformed input must flag, not throw', () => {
  const src = 'Mortality was 5%.'
  const cases = {
    'non-string quote (number)': q({ value: 5, source_quote: 5 }),
    'non-string quote (object)': q({ value: 5, source_quote: { a: 1 } }),
    'non-string quote (array)': q({ value: 5, source_quote: ['Mortality was 5%.'] }),
    'null quote': q({ value: 5, source_quote: null }),
    'undefined quote': q({ value: 5 }),
    'string value': q({ value: '5', source_quote: src }),
    'NaN value': q({ value: NaN, source_quote: src }),
    'Infinity ci': q({ value: 5, ci_low: Infinity, ci_high: -Infinity, source_quote: src }),
    'object name / unit': q({ name: { x: 1 }, unit: ['%'], value: 5, source_quote: src }),
    'numeric label': q({ quantity_type: 'comparison', value: null, first_label: 1, second_label: 2, first_value: 1, second_value: 2, source_quote: src }),
    'regex-special name/unit/labels': q({ name: 'a(b[c*', unit: '.*+?^${}()|[]\\', quantity_type: 'comparison', value: null, first_label: '(', second_label: '[', first_value: 1, second_value: 2, source_quote: 'a(b[c* was 1.*+?^${}()|[]\\ in ( and 2.*+?^${}()|[]\\ in [' }),
    'numeric location_hint': q({ value: 5, location_hint: 123, source_quote: src }),
    'object location_hint': q({ value: 5, location_hint: {}, source_quote: src }),
    'unknown extra field': q({ value: 5, name: 'Mortality', unit: '%', source_quote: src, weird: { deep: 1 } }),
    'null-proto quote': q({ value: 5, source_quote: Object.create(null) }),
  }
  for (const [label, quantity] of Object.entries(cases)) {
    it(`[robust] ${label}`, () => {
      let v
      expect(() => { v = run(quantity, src) }).not.toThrow()
      expect(VERIFIED.has(v.tier)).toBe(false)
    })
  }
  it('[robust] null quantity', () => {
    expect(() => run(null, src)).not.toThrow()
  })
  it('[robust] null / undefined / non-string source', () => {
    for (const s of [null, undefined, 5, {}, [], { text: null, tables: null }, { text: 5 }]) {
      let v
      expect(() => { v = run(q({ value: 5, source_quote: 'Mortality was 5%.' }), s) }).not.toThrow()
      expect(VERIFIED.has(v.tier)).toBe(false)
    }
  })
  it('[robust] null opts', () => {
    expect(() => verify(q({ value: 5, source_quote: src }), src, null)).not.toThrow()
  })
  it('[robust] registry rows of junk', () => {
    expect(() => run(q({ name: 'Mortality', unit: '%', value: 5, source_quote: src }), src, { registry: [null, 5, 'x', { measure: {} }, { measure: 'Mortality', unit: 1 }] })).not.toThrow()
  })
  it('[robust] huge quote / source finishes quickly and does not verify', () => {
    const big = 'hr 1.2 (95% ci 0.8-1.5) '.repeat(20000)
    const t = Date.now()
    const v = run(q({ unit: 'HR', value: 1.2, ci_low: 0.8, ci_high: 1.5, source_quote: big }), big)
    expect(Date.now() - t).toBeLessThan(5000)
    expect(VERIFIED.has(v.tier)).toBe(false)
  })
  it('[robust] pathological repetition for backtracking-prone regexes', () => {
    const evil = 'hazard ratio for ' + 'a '.repeat(50000) + 'was 1.2 (95% ci 0.8-1.5)'
    const t = Date.now()
    run(q({ unit: 'HR', value: 1.2, ci_low: 0.8, ci_high: 1.5, source_quote: evil }), evil)
    const evil2 = 'Of 100 patients (' + '5% x; '.repeat(20000) + ')'
    run(q({ unit: '%', value: 5, source_quote: evil2 }), evil2)
    const evil3 = '5 of 10' + ' a'.repeat(50000) + ' (50%)'
    run(q({ unit: '%', value: 50, source_quote: evil3 }), evil3)
    expect(Date.now() - t).toBeLessThan(8000)
  })
})
