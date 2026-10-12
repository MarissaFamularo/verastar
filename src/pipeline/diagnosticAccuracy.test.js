// Sensitivity/specificity pairs and a count whose denominator is printed earlier
// in the sentence. Positive controls are the real sentences. Everything else is a
// [false-verify guard]. A wrong metric, the wrong test, a swapped "respectively",
// or a percentage that does not round from n/N must stay unresolved.
import { describe, it, expect } from 'vitest'
import { verify, TIERS } from './verify.js'
import { isRelationshipValidated } from '../lib/evidenceVersion.js'

const base = { quantity_type: 'single', range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, ci_low: null, ci_high: null, p_value: null, unit: '%', location_hint: 'Results' }
const row = (fields) => ({ ...base, ...fields })
const verdict = (quantity, src, sourceTier = 'abstract_only') => verify(quantity, src, { sourceTier })
const shown = (quantity, src) => isRelationshipValidated(verdict(quantity, src))

const NHEART = 'nHEART achieved sensitivity of 97.1% and specificity of 53.8%.'
const PHEART = 'pHEART achieved sensitivity and specificity of 95.7% and 69.1%, respectively.'
const MACE = 'Of 1011 patients (48.5% female; mean age, 55.7 years), 69 (6.8%) experienced MACE within 6 weeks.'

describe('diagnostic accuracy bound to the named test', () => {
  const sens = (fields) => row({ name: 'nHEART sensitivity', value: 97.1, source_quote: NHEART, ...fields })
  const spec = (fields) => row({ name: 'nHEART specificity', value: 53.8, source_quote: NHEART, ...fields })

  it('binds each printed percentage to its metric and to nHEART', () => {
    const sensitivity = verdict(sens(), NHEART)
    expect(sensitivity.tier).toBe(TIERS.ABSTRACT)
    expect(sensitivity.endpointValidated).toBe(true)
    expect(sensitivity.relationshipStatus).toBe('validated')
    expect(sensitivity.flagged).toBe(false)
    const specificity = verdict(spec(), NHEART, 'full_text')
    expect(specificity.tier).toBe(TIERS.FULL_TEXT)
    expect(specificity.endpointValidated).toBe(true)
  })

  it('accepts had/showed and a name written as "sensitivity of <test>"', () => {
    for (const verb of ['had', 'showed']) {
      const src = `nHEART ${verb} sensitivity of 97.1% and specificity of 53.8%.`
      expect(shown(sens({ source_quote: src }), src)).toBe(true)
    }
    const src = 'The nHEART score showed sensitivity of 97.1% and specificity of 53.8%.'
    expect(shown(sens({ name: 'sensitivity of the nHEART score', source_quote: src }), src)).toBe(true)
  })

  it('binds "respectively" in the order the metrics are named', () => {
    const sensitivity = verdict(row({ name: 'pHEART sensitivity', value: 95.7, source_quote: PHEART }), PHEART)
    const specificity = verdict(row({ name: 'pHEART specificity', value: 69.1, source_quote: PHEART }), PHEART)
    expect(sensitivity.tier).toBe(TIERS.ABSTRACT)
    expect(sensitivity.endpointValidated).toBe(true)
    expect(specificity.endpointValidated).toBe(true)
    const flipped = 'pHEART achieved specificity and sensitivity of 69.1% and 95.7%, respectively.'
    expect(shown(row({ name: 'pHEART sensitivity', value: 95.7, source_quote: flipped }), flipped)).toBe(true)
    expect(shown(row({ name: 'pHEART specificity', value: 69.1, source_quote: flipped }), flipped)).toBe(true)
  })

  it('keeps each test when the sentence binds two tests separately', () => {
    const src = 'nHEART achieved sensitivity of 97.1% and specificity of 53.8%, and pHEART achieved sensitivity of 95.7% and specificity of 69.1%.'
    expect(shown(sens({ source_quote: src }), src)).toBe(true)
    expect(shown(row({ name: 'pHEART specificity', value: 69.1, source_quote: src }), src)).toBe(true)
    expect(shown(sens({ value: 95.7, source_quote: src }), src)).toBe(false)
  })

  it('still binds the test after a prepositional preamble', () => {
    const src = 'In this cohort, nHEART achieved sensitivity of 97.1% and specificity of 53.8%.'
    expect(shown(sens({ source_quote: src }), src)).toBe(true)
    const unlike = 'Unlike pHEART, nHEART achieved sensitivity of 97.1% and specificity of 53.8%.'
    expect(shown(sens({ source_quote: unlike }), unlike)).toBe(true)
    expect(shown(row({ name: 'pHEART sensitivity', value: 97.1, source_quote: unlike }), unlike)).toBe(false)
  })

  it('[false-verify guard] the other metric\'s percentage does not verify', () => {
    expect(shown(sens({ value: 53.8 }), NHEART)).toBe(false)
    expect(shown(spec({ value: 97.1 }), NHEART)).toBe(false)
    expect(verdict(sens({ value: 53.8 }), NHEART).tier).toBe(TIERS.LOCATED)
  })

  it('[false-verify guard] a swapped respectively order stays unresolved', () => {
    expect(shown(row({ name: 'pHEART sensitivity', value: 69.1, source_quote: PHEART }), PHEART)).toBe(false)
    expect(shown(row({ name: 'pHEART specificity', value: 95.7, source_quote: PHEART }), PHEART)).toBe(false)
    const missing = 'pHEART achieved sensitivity and specificity of 95.7% and 69.1%.'
    expect(shown(row({ name: 'pHEART sensitivity', value: 95.7, source_quote: missing }), missing)).toBe(false)
    const delayed = 'pHEART achieved sensitivity and specificity of 95.7% and 69.1% in the cohort, respectively.'
    expect(shown(row({ name: 'pHEART sensitivity', value: 95.7, source_quote: delayed }), delayed)).toBe(false)
  })

  it('[false-verify guard] the row name must be that metric and that test only', () => {
    expect(shown(sens({ name: 'pHEART sensitivity' }), NHEART)).toBe(false)
    expect(shown(sens({ name: 'sensitivity' }), NHEART)).toBe(false)
    expect(shown(sens({ name: 'nHEART' }), NHEART)).toBe(false)
    expect(shown(sens({ name: 'HEART sensitivity' }), NHEART)).toBe(false)
    expect(shown(sens({ name: 'nHEART sensitivity for MACE' }), NHEART)).toBe(false)
    expect(shown(sens({ name: 'nHEART sensitivity and specificity' }), NHEART)).toBe(false)
  })

  it('[false-verify guard] two tests sharing one pair have no clear binding', () => {
    for (const src of [
      'nHEART and pHEART achieved sensitivity of 97.1% and specificity of 53.8%.',
      'nHEART, pHEART achieved sensitivity of 97.1% and specificity of 53.8%.',
      'Both nHEART and pHEART showed sensitivity of 97.1% and specificity of 53.8%.',
    ]) {
      expect(shown(sens({ source_quote: src }), src)).toBe(false)
      expect(shown(row({ name: 'pHEART sensitivity', value: 97.1, source_quote: src }), src)).toBe(false)
    }
  })

  it('[false-verify guard] a cut quote that hides the rest of the sentence stays unresolved', () => {
    const quote = 'nHEART achieved sensitivity of 97.1% and specificity of 53.8%'
    const src = `${quote}, whereas pHEART achieved sensitivity of 10% and specificity of 20%.`
    expect(shown(sens({ source_quote: quote }), src)).toBe(false)
  })

  it('[false-verify guard] a confidence interval between the metrics, a claimed CI or P, another verb, or a second copy stays unresolved', () => {
    const between = 'nHEART achieved sensitivity of 97.1% (95% CI 90-99) and specificity of 53.8%.'
    expect(shown(sens({ source_quote: between }), between)).toBe(false)
    const claimed = 'nHEART achieved sensitivity of 97.1% and specificity of 53.8% (P = 0.01).'
    expect(shown(sens({ p_value: 0.01, source_quote: claimed }), claimed)).toBe(false)
    expect(shown(sens({ ci_low: 90, ci_high: 99 }), NHEART)).toBe(false)
    const demonstrated = 'nHEART demonstrated sensitivity of 97.1% and specificity of 53.8%.'
    expect(shown(sens({ source_quote: demonstrated }), demonstrated)).toBe(false)
    expect(shown(sens({ unit: 'HR' }), NHEART)).toBe(false)
    expect(shown(sens({ timepoint: '30 days' }), NHEART)).toBe(false)
    expect(shown(sens(), `${NHEART} ${NHEART}`)).toBe(false)
  })
})

describe('count whose denominator is printed earlier in the sentence', () => {
  const prop = (fields) => row({ name: 'MACE', value: 6.8, source_quote: MACE, ...fields })

  it('recomputes 69/1011 as 6.8% and leaves the outcome unchecked', () => {
    const v = verdict(prop(), MACE)
    expect(v.tier).toBe(TIERS.PROPORTION)
    expect(v.relationshipStatus).toBe('proportion-validated')
    expect(v.endpointValidated).toBe(false)
    expect(v.reason).toMatch(/recomputed/)
    expect(v.flagged).toBe(false)
  })

  it('accepts a cohort without the parenthetical, and "of the N patients"', () => {
    const plain = 'Of 1011 patients, 69 (6.8%) experienced MACE within 6 weeks.'
    expect(shown(prop({ source_quote: plain }), plain)).toBe(true)
    const the = 'Of the 1011 patients, 69 (6.8%) experienced MACE within 6 weeks.'
    expect(shown(prop({ source_quote: the }), the)).toBe(true)
  })

  it('keeps the contiguous "n of N (x%)" shape', () => {
    const src = 'MACE was experienced by 69 of 1011 patients (6.8%).'
    expect(shown(prop({ source_quote: src }), src)).toBe(true)
    const third = 'Of 3 patients, 1 (33%) experienced the event.'
    expect(shown(prop({ value: 33, source_quote: third }), third)).toBe(true)
  })

  it('[false-verify guard] n/N must round to the printed percentage', () => {
    const high = 'Of 1011 patients (48.5% female; mean age, 55.7 years), 69 (7.8%) experienced MACE within 6 weeks.'
    expect(shown(prop({ value: 7.8, source_quote: high }), high)).toBe(false)
    const rounded = 'Of 1011 patients (48.5% female; mean age, 55.7 years), 69 (6.9%) experienced MACE within 6 weeks.'
    expect(shown(prop({ value: 6.9, source_quote: rounded }), rounded)).toBe(false)
    const denom = 'Of 1000 patients (48.5% female; mean age, 55.7 years), 69 (6.8%) experienced MACE within 6 weeks.'
    expect(shown(prop({ source_quote: denom }), denom)).toBe(false)
    const third = 'Of 3 patients, 1 (34%) experienced the event.'
    expect(shown(prop({ value: 34, source_quote: third }), third)).toBe(false)
  })

  it('[false-verify guard] a demographic percentage, the count, or the follow-up is not the event rate', () => {
    expect(shown(prop({ value: 48.5 }), MACE)).toBe(false)
    expect(shown(prop({ value: 55.7 }), MACE)).toBe(false)
    expect(shown(prop({ value: 69 }), MACE)).toBe(false)
    expect(shown(prop({ value: 6 }), MACE)).toBe(false)
    expect(verdict(prop({ value: 48.5 }), MACE).tier).toBe(TIERS.LOCATED)
  })

  it('[false-verify guard] two event counts, a missing "experienced", or a count above the cohort stays unresolved', () => {
    const two = 'Of 1011 patients, 69 (6.8%) experienced MACE and 40 (4.0%) experienced death.'
    expect(shown(prop({ source_quote: two }), two)).toBe(false)
    expect(shown(prop({ value: 4, source_quote: two }), two)).toBe(false)
    const had = 'Of 1011 patients (48.5% female; mean age, 55.7 years), 69 (6.8%) had MACE within 6 weeks.'
    expect(shown(prop({ source_quote: had }), had)).toBe(false)
    const over = 'Of 50 patients, 69 (138%) experienced MACE.'
    expect(shown(prop({ value: 138, source_quote: over }), over)).toBe(false)
    expect(shown(prop({ ci_low: 5, ci_high: 8 }), MACE)).toBe(false)
  })
})
