// Printed two-group comparisons — the 2026-09-30 comparison tier.
//
// The tier proves one thing: the span prints exactly one "A vs B" pair whose left and right
// numbers are the extraction's first and second values, in that order, with any claimed
// unit printed on the pair and any claimed P printed directly after it. It never proves
// which groups or endpoint the values belong to. Positive controls are real Results
// phrasing from a 30 Sep digest; every other case is a [false-verify guard].
import { describe, it, expect } from 'vitest'
import { verify, TIERS } from './verify.js'
import { evidenceVerdict, isRelationshipValidated } from '../lib/evidenceVersion.js'

const base = { quantity_type: 'comparison', value: null, range_low: null, range_high: null, ci_low: null, ci_high: null, p_value: null, first_label: null, second_label: null, location_hint: 'Results' }
const cmp = (fields) => ({ ...base, name: 'Premenopausal status', unit: '%', ...fields })

const PREM = 'Node-positive patients were more often premenopausal (36% vs. 26%, P=0.035).'
const prem = cmp({ first_value: 36, second_value: 26, p_value: 0.035, source_quote: 'premenopausal (36% vs. 26%, P=0.035)' })
const LOS = 'The mean total operative time and length of stay were significantly shorter in the zone 2 TBE group (144.3 ± 63.7 vs 341.8 ± 106.8 minutes, P < .001; 2.9 ± 2.1 vs 4.1 ± 2.8 days, P = .025).'
const los = cmp({ name: 'Length of stay', unit: 'days', first_value: 2.9, second_value: 4.1, p_value: 0.025, source_quote: '2.9 ± 2.1 vs 4.1 ± 2.8 days, P = .025' })

describe('comparison tier — positive controls', () => {
  it('validates "(36% vs. 26%, P=0.035)" with the groups named elsewhere', () => {
    const v = verify(prem, PREM)
    expect(v.tier).toBe(TIERS.COMPARISON)
    expect(v.flagged).toBe(false)
    expect(v.relationshipValidated).toBe(true)
    expect(v.endpointValidated).toBe(false)
    expect(v.relationshipStatus).toBe('comparison-validated')
    expect(v.reason).toMatch(/groups and endpoint .* not checked/)
    expect(isRelationshipValidated(v)).toBe(true)
  })
  it('validates mean ± SD pairs with the unit after the right-hand value', () => {
    expect(verify(los, LOS).tier).toBe(TIERS.COMPARISON)
  })
  it('validates "versus" and an omitted P', () => {
    const src = 'Complete healing occurred in 64.5% versus 56.7% of wounds.'
    expect(verify(cmp({ first_value: 64.5, second_value: 56.7, source_quote: src }), src).tier).toBe(TIERS.COMPARISON)
  })
  it('keeps labels the quote contains (they stay unchecked)', () => {
    const src = 'Zone 2 TEVAR had more adverse events than zone 2 TBE (32.6% vs 12.5%, P = .028).'
    expect(verify(cmp({ first_label: 'Zone 2 TEVAR', second_label: 'zone 2 TBE', first_value: 32.6, second_value: 12.5, p_value: 0.028, source_quote: src }), src).tier).toBe(TIERS.COMPARISON)
  })
  it('reads a 2026-09-27 verdict as stamped', () => {
    const old = { verificationVersion: '2026-09-27.estimates-v2', tier: 'verified-estimate', flagged: false, relationshipValidated: true }
    expect(evidenceVerdict(old).tier).toBe('verified-estimate')
  })
})

describe('comparison tier — [false-verify guards]', () => {
  const expectWithheld = (quantity, source) => {
    const v = verify(quantity, source)
    expect(v.tier).not.toBe(TIERS.COMPARISON)
    expect(v.flagged).toBe(true)
    expect(v.relationshipValidated).toBe(false)
  }
  it('values in swapped order', () => expectWithheld({ ...prem, first_value: 26, second_value: 36 }, PREM))
  it('wrong P value', () => expectWithheld({ ...prem, p_value: 0.35 }, PREM))
  it('claims a P not printed directly after the pair', () => {
    const src = 'Tumors were larger (46.7% vs. 18.3% pT2-3, P<0.001).'
    expectWithheld(cmp({ first_value: 46.7, second_value: 18.3, p_value: 0.001, source_quote: src }), src)
  })
  it('an SD passed off as a group value', () => expectWithheld({ ...los, first_value: 2.1 }, LOS))
  it('unit claimed that the pair does not print', () => expectWithheld({ ...los, unit: 'hours' }, LOS))
  it('% claimed on a pair printed without it', () => {
    const src = 'Counts were 36 vs 26.'
    expectWithheld(cmp({ first_value: 36, second_value: 26, source_quote: src }), src)
  })
  it('two pairs in the quote', () => {
    expectWithheld({ ...los, source_quote: LOS.slice(LOS.indexOf('(') + 1, -2) }, LOS)
  })
  it('a CI anywhere in the span', () => {
    const src = 'Mortality was 12% vs 10% (difference 2%, 95% CI 1-3).'
    expectWithheld(cmp({ first_value: 12, second_value: 10, source_quote: src }), src)
  })
  it('claimed CI fields', () => {
    const src = 'Mortality was 12% vs 10%.'
    expectWithheld(cmp({ first_value: 12, second_value: 10, ci_low: 1, ci_high: 3, source_quote: src }), src)
  })
  it('a range bound is not a group value', () => {
    const src = 'Rates ranged 10-36% vs 26% overall.'
    expectWithheld(cmp({ first_value: 36, second_value: 26, source_quote: src }), src)
  })
  it('a value separated from the comparator by another number', () => {
    const src = 'Mortality was 36 (12%) vs 26 (10%).'
    expectWithheld(cmp({ unit: null, first_value: 12, second_value: 26, source_quote: src }), src)
  })
  it('words between a value and the comparator', () => {
    const src = 'Mortality was 10.7% with CEA vs. 9.0% with CAS.'
    expectWithheld(cmp({ first_value: 10.7, second_value: 9, source_quote: src }), src)
  })
  it('"compared with" is not admitted', () => {
    const src = 'Mortality was 36% compared with 26%.'
    expectWithheld(cmp({ first_value: 36, second_value: 26, source_quote: src }), src)
  })
  it('flattened table corpus', () => expectWithheld(prem, { tables: PREM }))
  it('fuzzy (re-punctuated) quote', () => expectWithheld({ ...prem, source_quote: 'premenopausal 36% vs 26% P=0.035' }, PREM))
  it('quote repeated elsewhere in the source', () => expectWithheld(prem, `${PREM} ${PREM}`))
  it('unbound qualifiers are never silently accepted', () => {
    for (const extra of [{ population: 'women' }, { timepoint: '12 months' }, { endpoint: 'MACE' }, { subgroup: 'diabetes' }]) {
      expectWithheld({ ...prem, ...extra }, PREM)
    }
  })
  it('a number that is part of a name', () => {
    const src = 'Perfusion rose with TcPO2 vs 30 mmHg at rest.'
    expectWithheld(cmp({ unit: 'mmHg', first_value: 2, second_value: 30, source_quote: src }), src)
  })
  it('negative values stay unresolved', () => {
    const src = 'Change was -4 vs 2 points.'
    expectWithheld(cmp({ unit: 'points', first_value: -4, second_value: 2, source_quote: src }), src)
  })
})
