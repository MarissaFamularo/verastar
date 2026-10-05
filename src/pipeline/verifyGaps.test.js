// The 2026-10-04 grammar gaps — true printed values that could never verify, found on
// her real digest. Each new rule is narrow: positive controls are the real sentences, and
// every other case is a [false-verify guard]. Zero false verifies outranks any coverage.
import { describe, it, expect } from 'vitest'
import { verify, TIERS, VERIFICATION_VERSION, COMPATIBLE_VERIFICATION_VERSIONS } from './verify.js'
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
  it('[false-verify guard] I² has no rule and stays unverified', () => {
    expect(ok(q({ name: 'I²', unit: '%', value: 89, source_quote: FRAILTY }), FRAILTY)).toBe(false)
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

describe('version', () => {
  it('bumps, and keeps the previous stamp readable — new rules only add coverage', () => {
    expect(VERIFICATION_VERSION).toBe('2026-10-04.estimates-v4')
    expect(COMPATIBLE_VERIFICATION_VERSIONS).toContain('2026-09-30.estimates-v3')
    const old = { ...verify(q({ name: 'x', unit: 'HR', value: 0.84, ci_low: 0.61, ci_high: 1.16, source_quote: 'HR 0.84 (95% CI 0.61-1.16)' }), 'Results: HR 0.84 (95% CI 0.61-1.16).'), verificationVersion: '2026-09-30.estimates-v3' }
    expect(evidenceVerdict(old).tier).toBe(old.tier)
  })
})
