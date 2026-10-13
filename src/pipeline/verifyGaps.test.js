// The 2026-10-04 grammar gaps — true printed values that could never verify, found on
// her real digest. Each new rule is narrow: positive controls are the real sentences, and
// every other case is a [false-verify guard]. Zero false verifies outranks any coverage.
import { describe, it, expect } from 'vitest'
import { verify, TIERS, VERIFICATION_VERSION, COMPATIBLE_VERIFICATION_VERSIONS, FULLY_COMPATIBLE_VERIFICATION_VERSIONS, TIGHTENED_TIERS } from './verify.js'
import { evidenceVerdict, isRelationshipValidated } from '../lib/evidenceVersion.js'

const base = { quantity_type: 'single', range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, ci_low: null, ci_high: null, p_value: null, unit: null, location_hint: 'Results' }
const q = (fields) => ({ ...base, name: 'Result', ...fields })
const ok = (quantity, src) => isRelationshipValidated(verify(quantity, src, { sourceTier: 'abstract_only' }))

describe('estimate with a qualifier between measure and verb (frailty meta-analysis)', () => {
  const FRAILTY = 'The exploratory pooled hazard ratio for the prioritized highest/binary frailty contrast versus the lowest/non-frail reference group was 1.81 (95% confidence interval = 0.97-3.39; k = 2; τ² = 0.18; I² = 89.0%; Cochran Q-test p = 0.003 for heterogeneity).'
  const hr = (fields) => q({ name: 'Pooled HR, death or major amputation', unit: 'HR', value: 1.81, ci_low: 0.97, ci_high: 3.39, source_quote: FRAILTY, ...fields })

  it('verifies the real sentence as an estimate, endpoint unchecked', () => {
    const v = verify(hr(), FRAILTY, { sourceTier: 'abstract_only' })
    expect(v.tier).toBe(TIERS.ESTIMATE)
    expect(v.endpointValidated).toBe(false)
  })
  it('accepts "confidence interval =" and an English "or" in the qualifier', () => {
    const src = 'The hazard ratio for death or major amputation was 0.72 (95% CI = 0.55-0.94).'
    expect(ok(q({ unit: 'HR', value: 0.72, ci_low: 0.55, ci_high: 0.94, source_quote: src }), src)).toBe(true)
  })
  it('[false-verify guard] a heterogeneity P is not the estimate P', () => {
    expect(ok(hr({ p_value: 0.003 }), FRAILTY)).toBe(false)
  })
  it('[false-verify guard] a qualifier spanning a clause cannot borrow a later value', () => {
    const src = 'The hazard ratio for death was similar across strata and the rate was 1.20 (95% CI 1.01-1.43).'
    expect(ok(q({ unit: 'HR', value: 1.2, ci_low: 1.01, ci_high: 1.43, source_quote: src }), src)).toBe(false)
  })
  it('[false-verify guard] a qualifier naming a second measure is ambiguous', () => {
    const src = 'The hazard ratio for mortality and the odds ratio for stroke were 1.30 (95% CI 1.10-1.55).'
    expect(ok(q({ unit: 'HR', value: 1.3, ci_low: 1.1, ci_high: 1.55, source_quote: src }), src)).toBe(false)
  })
  it('[false-verify guard] a qualifier holding a number is refused', () => {
    const src = 'The hazard ratio for patients over 65 years was 1.30 (95% CI 1.10-1.55).'
    expect(ok(q({ unit: 'HR', value: 1.3, ci_low: 1.1, ci_high: 1.55, source_quote: src }), src)).toBe(false)
  })
  it('[false-verify guard] a mistranscribed CI bound still fails', () => {
    expect(ok(hr({ ci_high: 3.93 }), FRAILTY)).toBe(false)
  })
})

describe('two groups joined by "and" (SFA technical success)', () => {
  const SRC = 'Technical success was similar for RA + DCB (94.3%) and DCB alone (94.6%).'
  const pair = (fields) => q({ name: 'Technical success', quantity_type: 'comparison', value: null, unit: '%', first_label: 'RA + DCB', first_value: 94.3, second_label: 'DCB alone', second_value: 94.6, source_quote: SRC, ...fields })

  it('verifies the real sentence as a comparison, groups unchecked', () => {
    const v = verify(pair(), SRC, { sourceTier: 'abstract_only' })
    expect(v.tier).toBe(TIERS.COMPARISON)
    expect(v.endpointValidated).toBe(false)
  })
  it('[false-verify guard] swapped values fail — each value must follow its own label', () => {
    expect(ok(pair({ first_value: 94.6, second_value: 94.3 }), SRC)).toBe(false)
  })
  it('[false-verify guard] without labels an "and" list is not a comparison', () => {
    expect(ok(pair({ first_label: null, second_label: null }), SRC)).toBe(false)
  })
  it('[false-verify guard] two endpoints listed with "and" and no comparison cue', () => {
    const src = 'At one year we observed mortality (5%) and stroke (3%).'
    expect(ok(pair({ first_label: 'mortality', first_value: 5, second_label: 'stroke', second_value: 3, source_quote: src }), src)).toBe(false)
  })
  it('[false-verify guard] a third bracketed group makes the pair ambiguous', () => {
    const src = 'Technical success was similar for RA + DCB (94.3%), DCB alone (94.6%) and POBA (91.0%).'
    expect(ok(pair({ source_quote: src }), src)).toBe(false)
  })
  it('[false-verify guard] a claimed P has nothing to bind to', () => {
    expect(ok(pair({ p_value: 0.9 }), SRC)).toBe(false)
  })
  it('[false-verify guard] a label not printed directly before its value fails', () => {
    const src = 'Technical success was similar for RA + DCB and DCB alone (94.3%) and (94.6%).'
    expect(ok(pair({ source_quote: src }), src)).toBe(false)
  })
})

describe('percentages bound to arms without "vs" (X in A and Y in B)', () => {
  const HF13 = 'a primary-outcome event occurred in 129 patients (37.2%) in the PCI group and in 134 patients (38.0%) in the optimal-medical-therapy group'
  const pair = (fields) => q({
    name: 'Primary-outcome event incidence, PCI vs optimal-medical-therapy group',
    quantity_type: 'comparison',
    value: null,
    unit: '%',
    first_label: 'PCI group',
    first_value: 37.2,
    second_label: 'optimal-medical-therapy group',
    second_value: 38,
    source_quote: HF13,
    ...fields,
  })

  it('verifies the REVIVED sentence: each percentage is in its own arm', () => {
    const v = verify(pair(), HF13, { sourceTier: 'abstract_only' })
    expect(v.tier).toBe(TIERS.COMPARISON)
    expect(v.endpointValidated).toBe(false)
    expect(v.relationshipStatus).toBe('comparison-validated')
  })
  it('accepts a count of a denominator and an arm stem that the sentence finishes with "group"', () => {
    const src = 'a primary-outcome event occurred in 302 of 709 patients (42.6%) in the surgical group and in 408 of 711 patients (57.4%) in the endovascular group'
    expect(ok(pair({
      name: 'Cohort 1 primary-outcome events',
      first_label: 'surgical group',
      first_value: 42.6,
      second_label: 'endovascular group',
      second_value: 57.4,
      source_quote: src,
    }), src)).toBe(true)
    const stem = 'the primary outcome had occurred in 914 patients (21.8%) in the LCZ696 group and 1117 patients (26.5%) in the enalapril group'
    expect(ok(pair({
      name: 'Primary composite outcome incidence',
      first_label: 'LCZ696',
      first_value: 21.8,
      second_label: 'enalapril',
      second_value: 26.5,
      source_quote: stem,
    }), stem)).toBe(true)
  })
  it('negative: swapped arms do not verify', () => {
    expect(ok(pair({ first_label: 'optimal-medical-therapy group', first_value: 37.2, second_label: 'PCI group', second_value: 38 }), HF13)).toBe(false)
    expect(ok(pair({ first_label: 'optimal-medical-therapy group', first_value: 38, second_label: 'PCI group', second_value: 37.2 }), HF13)).toBe(false)
  })
  it('negative: swapped values do not verify', () => {
    expect(ok(pair({ first_value: 38, second_value: 37.2 }), HF13)).toBe(false)
  })
  it('negative: an ambiguous comparison does not verify', () => {
    const bothOrders = 'Events occurred in 129 patients (37.2%) in the PCI group and in 134 patients (38.0%) in the optimal-medical-therapy group, or in 134 patients (38.0%) in the PCI group and in 129 patients (37.2%) in the optimal-medical-therapy group.'
    expect(ok(pair({ source_quote: bothOrders }), bothOrders)).toBe(false)
    const unbound = 'Events occurred in (37.2%) and (38.0%) in the PCI group and the optimal-medical-therapy group.'
    expect(ok(pair({ source_quote: unbound }), unbound)).toBe(false)
    const oneValue = 'Events occurred in 129 patients (37.2%) in the PCI group and in the optimal-medical-therapy group.'
    expect(ok(pair({ source_quote: oneValue }), oneValue)).toBe(false)
    const third = 'Events occurred in 129 patients (37.2%) in the PCI group and in 134 patients (38.0%) in the optimal-medical-therapy group and in 10 patients (4.0%) in the surgery group.'
    expect(ok(pair({ source_quote: third }), third)).toBe(false)
    const endpoints = 'Death was (5%) in year 1 and stroke was (3%) in the hospital.'
    expect(ok(pair({ first_label: 'year 1', first_value: 5, second_label: 'the hospital', second_value: 3, source_quote: endpoints }), endpoints)).toBe(false)
    const receiving = 'in 751 of 6930 patients (10.8%) receiving ticagrelor and in 740 of 6955 (10.6%) receiving clopidogrel'
    expect(ok(pair({ first_label: 'ticagrelor', first_value: 10.8, second_label: 'clopidogrel', second_value: 10.6, source_quote: receiving }), receiving)).toBe(false)
    const versus = 'Events occurred in 37.2% vs 38.0%.'
    expect(ok(pair({ source_quote: versus, unit: null }), versus)).toBe(false)
  })
  it('negative: a claimed P or CI has nothing in this shape to bind to', () => {
    expect(ok(pair({ p_value: 0.96 }), HF13)).toBe(false)
    const withCi = `${HF13} (hazard ratio, 0.99; 95% CI, 0.78 to 1.27).`
    expect(ok(pair({ source_quote: withCi }), withCi)).toBe(false)
  })
  it('[false-verify guard] negation, falsity, a question, and a hypothetical are not this sentence', () => {
    const clause = HF13
    const repros = [
      `The claim was false: ${clause}.`,
      `It is untrue that ${clause}.`,
      `Suppose ${clause}.`,
      'An event didn\'t occur in 129 patients (37.2%) in the PCI group and in 134 patients (38.0%) in the optimal-medical-therapy group.',
      `It is not true that ${clause}.`,
      `Prior studies reported ${clause}.`,
      `If ${clause}.`,
      `It was hypothesized that ${clause}.`,
      `Would ${clause}.`,
      `Unlike earlier trials, ${clause}.`,
      `In this cohort, ${clause}.`,
      'a primary-outcome event did not occur in 129 patients (37.2%) in the PCI group and in 134 patients (38.0%) in the optimal-medical-therapy group.',
      `${clause}?`,
      `${clause}!`,
      `${clause}...`,
      `${clause}.?`,
      `${clause}, whereas surgery was higher.`,
      `${clause} compared with surgery.`,
    ]
    for (const src of repros) {
      expect(ok(pair({ source_quote: src }), src), src).toBe(false)
      expect(ok(pair({ source_quote: clause }), src), src).toBe(false)
    }
    // The quote drops the mark; the source sentence still asks it.
    expect(ok(pair({ source_quote: clause }), `${clause}?`)).toBe(false)
    expect(ok(pair({ source_quote: clause }), `${clause}?"`)).toBe(false)
  })
  it('accepts a period outside the quote and the end of the text', () => {
    expect(ok(pair({ source_quote: HF13 }), `${HF13}.`)).toBe(true)
    for (const lead of ['Overall, ', 'At 30 days, ', 'In the PCI group, ']) {
      const sentence = `${lead}${HF13}`
      expect(ok(pair({ source_quote: sentence }), `${sentence}.`), lead).toBe(true)
    }
    expect(ok(pair({ source_quote: HF13 }), HF13)).toBe(true)
    expect(ok(pair({ source_quote: HF13 }), `Earlier work differed. ${HF13}.`)).toBe(true)
    expect(ok(pair({ source_quote: `${HF13}.` }), `${HF13}.`)).toBe(true)
  })
})

describe('proportion recomputed from its printed count (SFA lesion crossing)', () => {
  const SRC = 'Successful lesion crossing was achieved in 109 of 117 CTOs (93.2%).'
  const prop = (fields) => q({ name: 'Successful lesion crossing', unit: '%', value: 93.2, source_quote: SRC, ...fields })

  it('verifies the real sentence: 109/117 = 93.16… prints as 93.2', () => {
    const v = verify(prop(), SRC, { sourceTier: 'abstract_only' })
    expect(v.tier).toBe(TIERS.PROPORTION)
    expect(v.relationshipStatus).toBe('proportion-validated')
    expect(v.endpointValidated).toBe(false)
    expect(v.reason).toMatch(/recomputed/)
  })
  it('accepts "out of", a slash, and whole-number rounding', () => {
    const a = 'Limb salvage was achieved in 45 out of 50 patients (90%).'
    expect(ok(prop({ value: 90, source_quote: a }), a)).toBe(true)
    const b = 'Patency was maintained in 1/3 (33%).'
    expect(ok(prop({ value: 33, source_quote: b }), b)).toBe(true)
  })
  it('[false-verify guard] a percentage that does not follow from the count fails', () => {
    const src = 'Successful lesion crossing was achieved in 109 of 117 CTOs (92.2%).'
    expect(ok(prop({ value: 92.2, source_quote: src }), src)).toBe(false)
    const third = 'Patency was maintained in 1/3 (34%).'
    expect(ok(prop({ value: 34, source_quote: third }), third)).toBe(false)
  })
  it('[false-verify guard] the claimed value must be the bracketed percentage', () => {
    expect(ok(prop({ value: 109 }), SRC)).toBe(false)
  })
  it('[false-verify guard] two count tuples in one quote are ambiguous', () => {
    const src = 'Crossing succeeded in 109 of 117 CTOs (93.2%) and 50 of 60 stenoses (83.3%).'
    expect(ok(prop({ source_quote: src }), src)).toBe(false)
  })
  it('[false-verify guard] a count above its denominator, or a CI claim, fails', () => {
    const src = 'Events occurred in 120 of 117 CTOs (102.6%).'
    expect(ok(prop({ value: 102.6, source_quote: src }), src)).toBe(false)
    expect(ok(prop({ ci_low: 90, ci_high: 96 }), SRC)).toBe(false)
  })
})

describe('heterogeneity I² (frailty meta-analysis)', () => {
  const FRAILTY = 'The exploratory pooled hazard ratio for the prioritized highest/binary frailty contrast versus the lowest/non-frail reference group was 1.81 (95% confidence interval = 0.97-3.39; k = 2; τ² = 0.18; I² = 89.0%; Cochran Q-test p = 0.003 for heterogeneity).'
  const i2 = (fields) => q({ name: 'Heterogeneity (I²) for pooled death or major amputation analysis', unit: '%', value: 89, source_quote: FRAILTY, ...fields })

  it('verifies the real sentence, analysis unchecked', () => {
    const v = verify(i2(), FRAILTY, { sourceTier: 'abstract_only' })
    expect(v.tier).toBe(TIERS.HETEROGENEITY)
    expect(v.relationshipStatus).toBe('heterogeneity-validated')
    expect(v.endpointValidated).toBe(false)
  })
  it('accepts "I2", a colon, and "was"', () => {
    for (const src of ['Heterogeneity was substantial (I2: 76%).', 'Heterogeneity was substantial; I² was 76%.']) {
      expect(ok(i2({ value: 76, source_quote: src }), src)).toBe(true)
    }
  })
  it('[false-verify guard] τ² is not I²', () => {
    expect(ok(i2({ name: 'Heterogeneity (tau²)', unit: null, value: 0.18 }), FRAILTY)).toBe(false)
  })
  it('[false-verify guard] a percentage not named as I² or heterogeneity proves nothing', () => {
    expect(ok(i2({ name: 'Pooled event rate' }), FRAILTY)).toBe(false)
  })
  it('[false-verify guard] a mistranscribed I² fails', () => {
    expect(ok(i2({ value: 98 }), FRAILTY)).toBe(false)
  })
  it('[false-verify guard] two I² values in one quote are ambiguous', () => {
    const src = 'Heterogeneity was high for mortality (I² = 89%) and low for stroke (I² = 12%).'
    expect(ok(i2({ value: 89, source_quote: src }), src)).toBe(false)
  })
  it('carries the Q-test P when the quote labels it as the heterogeneity test', () => {
    expect(ok(i2({ p_value: 0.003 }), FRAILTY)).toBe(true)
    const src = 'Heterogeneity was substantial (I² = 76%, P for heterogeneity = 0.01).'
    expect(ok(i2({ value: 76, p_value: 0.01, source_quote: src }), src)).toBe(true)
  })
  it('[false-verify guard] a mistranscribed heterogeneity P fails', () => {
    expect(ok(i2({ p_value: 0.03 }), FRAILTY)).toBe(false)
  })
  it('[false-verify guard] the pooled estimate\'s own P is not the heterogeneity P', () => {
    const src = 'The pooled odds ratio was 1.40 (P = 0.02), with I² = 55%.'
    expect(ok(i2({ value: 55, p_value: 0.02, source_quote: src }), src)).toBe(false)
  })
  it('[false-verify guard] two heterogeneity P values in one quote are ambiguous', () => {
    const src = 'Heterogeneity was high (I² = 89%; Q-test p = 0.003), versus low in the sensitivity analysis (Q-test p = 0.40).'
    expect(ok(i2({ value: 89, p_value: 0.003, source_quote: src }), src)).toBe(false)
  })
  it('[false-verify guard] "i2" inside a word is not I²', () => {
    const src = 'Heterogeneity analysis of the MI2 cohort found 40% recurrence.'
    expect(ok(i2({ value: 40, source_quote: src }), src)).toBe(false)
  })
})

describe('version', () => {
  it('bumps, and keeps the previous stamps readable outside the tiers v7 tightened', () => {
    expect(VERIFICATION_VERSION).toBe('2026-10-13.estimates-v15')
    expect(FULLY_COMPATIBLE_VERIFICATION_VERSIONS).toEqual(expect.arrayContaining(['2026-10-12.estimates-v12', '2026-10-12.estimates-v9', '2026-10-10.estimates-v8', '2026-10-09.estimates-v7']))
    expect(FULLY_COMPATIBLE_VERIFICATION_VERSIONS).not.toContain('2026-10-13.estimates-v13')
    expect(COMPATIBLE_VERIFICATION_VERSIONS).not.toContain('2026-10-13.estimates-v13')
    expect(FULLY_COMPATIBLE_VERIFICATION_VERSIONS).not.toContain('2026-10-13.estimates-v14')
    expect(COMPATIBLE_VERIFICATION_VERSIONS).not.toContain('2026-10-13.estimates-v14')
    const v14 = { verificationVersion: '2026-10-13.estimates-v14', tier: TIERS.COMPARISON, relationshipValidated: true, flagged: false }
    expect(evidenceVerdict(v14).tier).toBe('legacy-unchecked')
    const v12 = { verificationVersion: '2026-10-12.estimates-v12', tier: TIERS.COMPARISON, relationshipValidated: true, flagged: false }
    expect(evidenceVerdict(v12)).toBe(v12)
    expect(FULLY_COMPATIBLE_VERIFICATION_VERSIONS).not.toContain('2026-10-12.estimates-v10')
    expect(FULLY_COMPATIBLE_VERIFICATION_VERSIONS).not.toContain('2026-10-12.estimates-v11')
    expect(COMPATIBLE_VERIFICATION_VERSIONS).not.toContain('2026-10-12.estimates-v10')
    expect(COMPATIBLE_VERIFICATION_VERSIONS).not.toContain('2026-10-12.estimates-v11')
    expect(COMPATIBLE_VERIFICATION_VERSIONS).toEqual(expect.arrayContaining(['2026-09-30.estimates-v3', '2026-10-04.estimates-v4', '2026-10-04.estimates-v5', '2026-10-04.estimates-v6']))
    const v9 = { verificationVersion: '2026-10-12.estimates-v9', tier: TIERS.PROPORTION, relationshipValidated: true, flagged: false }
    expect(evidenceVerdict(v9)).toBe(v9)
    const v10 = { verificationVersion: '2026-10-12.estimates-v10', tier: TIERS.FULL_TEXT, relationshipValidated: true, flagged: false }
    expect(evidenceVerdict(v10).tier).toBe('legacy-unchecked')
    const v11 = { verificationVersion: '2026-10-12.estimates-v11', tier: TIERS.FULL_TEXT, relationshipValidated: true, flagged: false }
    expect(evidenceVerdict(v11).tier).toBe('legacy-unchecked')
    const v13 = { verificationVersion: '2026-10-13.estimates-v13', tier: TIERS.COMPARISON, relationshipValidated: true, flagged: false }
    expect(evidenceVerdict(v13).tier).toBe('legacy-unchecked')
    const old = { ...verify(q({ name: 'x', unit: 'HR', value: 0.84, ci_low: 0.61, ci_high: 1.16, source_quote: 'HR 0.84 (95% CI 0.61-1.16)' }), 'Results: HR 0.84 (95% CI 0.61-1.16).'), verificationVersion: '2026-09-30.estimates-v3' }
    // An estimate verdict is in a tier v7 tightened (P binding), so an old stamp there is
    // no longer a subset and is downgraded; the read paths re-derive it from saved source.
    expect(old.tier).toBe(TIERS.ESTIMATE)
    expect(TIGHTENED_TIERS).toEqual([TIERS.ESTIMATE, TIERS.COMPARISON])
    expect(evidenceVerdict(old).tier).toBe('legacy-unchecked')
    const sentence = { ...old, tier: TIERS.ABSTRACT, relationshipStatus: 'validated' }
    expect(evidenceVerdict(sentence)).toBe(sentence)
  })
})
