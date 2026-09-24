// Printed ratio estimates — the 2026-09-24 estimate tier.
//
// The tier proves one thing: a single printed ratio tuple binds value, CI bounds and P in
// their stated roles. It never proves which endpoint the tuple belongs to. Positive
// controls are real Results phrasing; every other case is a [false-verify guard].
import { describe, it, expect } from 'vitest'
import { verify, TIERS } from './verify.js'
import { evidenceVerdict, isRelationshipValidated } from '../lib/evidenceVersion.js'

const base = { quantity_type: 'single', range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, location_hint: 'Results' }
const est = (fields) => ({ ...base, name: 'Risk of bleeding', unit: 'HR', ...fields })

const DAPT = 'Short-term DAPT was associated with a reduction in the risk of bleeding (HR, 0.44; 95% CI, 0.34-0.55; P < .001), while preserving ischemic protection, with no differences in the risk of major adverse cardiac events (HR, 1.05; 95% CI, 0.83-1.32; P = .71).'
const bleeding = est({ value: 0.44, ci_low: 0.34, ci_high: 0.55, p_value: 0.001, source_quote: 'a reduction in the risk of bleeding (HR, 0.44; 95% CI, 0.34-0.55; P < .001)' })

describe('estimate tier — positive controls', () => {
  it('validates a JAMA-style parenthetical tuple from a sentence fragment', () => {
    const v = verify(bleeding, DAPT)
    expect(v.tier).toBe(TIERS.ESTIMATE)
    expect(v.flagged).toBe(false)
    expect(v.relationshipValidated).toBe(true)
    expect(v.endpointValidated).toBe(false)
    expect(v.relationshipStatus).toBe('estimate-validated')
    expect(v.reason).toMatch(/not checked/)
    expect(isRelationshipValidated(v)).toBe(true)
  })
  it('validates the second tuple of a two-tuple sentence when the quote isolates it', () => {
    const mace = est({ name: 'MACE', value: 1.05, ci_low: 0.83, ci_high: 1.32, p_value: 0.71, source_quote: 'major adverse cardiac events (HR, 1.05; 95% CI, 0.83-1.32; P = .71)' })
    expect(verify(mace, DAPT).tier).toBe(TIERS.ESTIMATE)
  })
  it('validates "hazard ratio was X (97.5% CI a to b, P=p)" with a sentence-final period', () => {
    const src = 'For amputation-free survival the hazard ratio was 0.84 (97.5% CI 0.61 to 1.16, P=0.22).'
    const v = verify(est({ value: 0.84, ci_low: 0.61, ci_high: 1.16, p_value: 0.22, unit: 'hazard ratio', source_quote: src }), src)
    expect(v.tier).toBe(TIERS.ESTIMATE)
  })
  it('validates an unbracketed tuple ending the sentence without a P value', () => {
    const src = 'The adjusted OR was 1.91, 95% CI 1.26-2.90.'
    expect(verify(est({ value: 1.91, ci_low: 1.26, ci_high: 2.9, p_value: null, unit: 'OR', source_quote: src }), src).tier).toBe(TIERS.ESTIMATE)
  })
  it('validates en-dash and interpunct printing', () => {
    const src = 'Mortality fell (HR 0·84, 95% CI 0·61–1·16; p=0·22).'
    expect(verify(est({ value: 0.84, ci_low: 0.61, ci_high: 1.16, p_value: 0.22, source_quote: src }), src).tier).toBe(TIERS.ESTIMATE)
  })
  it('allows a null unit and a P the extraction omitted', () => {
    expect(verify({ ...bleeding, unit: null, p_value: null }, DAPT).tier).toBe(TIERS.ESTIMATE)
  })
  it('reports abstract and user-text provenance in the reason', () => {
    expect(verify(bleeding, DAPT, { sourceTier: 'abstract_only' }).reason).toMatch(/abstract/)
    expect(verify(bleeding, DAPT, { sourceTier: 'user_text' }).reason).toMatch(/text you supplied/)
  })
  it('still attaches plausibility warnings as verified-as-printed', () => {
    const src = 'Bleeding fell (HR, 0.95; 95% CI, 0.40-0.90; P = .04).'
    const v = verify(est({ value: 0.95, ci_low: 0.4, ci_high: 0.9, p_value: 0.04, source_quote: src }), src)
    expect(v.tier).toBe(TIERS.ESTIMATE)
    expect(v.warnings.map((w) => w.status)).toContain('verified-as-printed')
  })
})

describe('estimate tier — [false-verify guards]', () => {
  const expectWithheld = (quantity, source, opts) => {
    const v = verify(quantity, source, opts)
    expect(v.tier).not.toBe(TIERS.ESTIMATE)
    expect(v.flagged).toBe(true)
    expect(v.relationshipValidated).toBe(false)
  }
  it('value and CI bound swapped', () => expectWithheld({ ...bleeding, value: 0.34, ci_low: 0.44 }, DAPT))
  it('CI bounds swapped', () => expectWithheld({ ...bleeding, ci_low: 0.55, ci_high: 0.34 }, DAPT))
  it('P value placed in the CI', () => expectWithheld({ ...bleeding, ci_low: 0.001 }, DAPT))
  it('wrong P value', () => expectWithheld({ ...bleeding, p_value: 0.01 }, DAPT))
  it('claims a P the tuple does not print', () => {
    const src = 'Bleeding fell (HR, 0.44; 95% CI, 0.34-0.55), P < .001 overall.'
    expectWithheld(est({ value: 0.44, ci_low: 0.34, ci_high: 0.55, p_value: 0.001, source_quote: src }), src)
  })
  it('values borrowed across two tuples in one quote', () => {
    expectWithheld(est({ value: 0.44, ci_low: 0.83, ci_high: 1.32, p_value: null, source_quote: DAPT }), DAPT)
  })
  it('correct first tuple but a second tuple in the same quote', () => expectWithheld({ ...bleeding, source_quote: DAPT }, DAPT))
  it('a second CI in another grammar inside the quote', () => {
    const src = 'Bleeding fell (HR, 0.44; 95% CI, 0.34-0.55) and 12% (95% CI 8-15%) of patients stopped.'
    expectWithheld(est({ value: 0.44, ci_low: 0.34, ci_high: 0.55, p_value: null, source_quote: src }), src)
  })
  it('truncated CI bound (quote ends mid-number)', () => {
    const src = 'Bleeding fell (HR, 0.44; 95% CI, 0.34-0.553; P < .001).'
    expectWithheld(est({ value: 0.44, ci_low: 0.34, ci_high: 0.55, p_value: null, source_quote: 'Bleeding fell (HR, 0.44; 95% CI, 0.34-0.55' }), src)
  })
  it('English "or" is not an odds ratio', () => {
    const src = 'Mortality was 10% or 0.10 (95% CI 0.08-0.12).'
    expectWithheld(est({ value: 0.1, ci_low: 0.08, ci_high: 0.12, unit: null, source_quote: src }), src)
  })
  it('unit names a different measure than the source', () => expectWithheld({ ...bleeding, unit: 'OR' }, DAPT))
  it('unit that is not a ratio name', () => expectWithheld({ ...bleeding, unit: '%' }, DAPT))
  it('mean differences stay unresolved (signed values, units)', () => {
    const src = 'The mean difference was -0.4 mmHg (95% CI -0.9 to 0.1; P = .12).'
    expectWithheld(est({ name: 'BP', value: -0.4, ci_low: -0.9, ci_high: 0.1, p_value: 0.12, unit: 'mmHg', source_quote: src }), src)
  })
  it('measure separated from its value by an endpoint phrase', () => {
    const src = 'The HR for death at 30 days 0.44 (95% CI 0.34-0.55).'
    expectWithheld(est({ value: 0.44, ci_low: 0.34, ci_high: 0.55, p_value: null, source_quote: src }), src)
  })
  it('flattened table corpus', () => expectWithheld(bleeding, { tables: DAPT }))
  it('fuzzy (re-punctuated) quote', () => expectWithheld({ ...bleeding, source_quote: 'reduction in the risk of bleeding HR 0.44 95% CI 0.34-0.55 P < .001' }, DAPT))
  it('quote repeated elsewhere in the source', () => expectWithheld(bleeding, DAPT + ' ' + DAPT))
  it('non-single shapes', () => {
    expectWithheld({ ...bleeding, quantity_type: 'range', value: null, range_low: 0.34, range_high: 0.55 }, DAPT)
  })
  it('missing name', () => expectWithheld({ ...bleeding, name: '' }, DAPT))
  it('missing CI in the claim', () => expectWithheld({ ...bleeding, ci_low: null, ci_high: null }, DAPT))
  it('unbound qualifiers are never silently accepted', () => {
    for (const extra of [{ population: 'women' }, { timepoint: '12 months' }, { endpoint: 'MACE' }, { subgroup: 'diabetes' }]) {
      expectWithheld({ ...bleeding, ...extra }, DAPT)
    }
  })
  it('nudged value (corruption test) is flagged', () => {
    const v = verify({ ...bleeding, value: 0.45 }, DAPT)
    expect(v.tier).toBe(TIERS.FLAGGED)
  })
})

describe('verification version compatibility', () => {
  it('keeps a 2026-09-11 verdict as stamped (a strict subset of current guarantees)', () => {
    const old = { verificationVersion: '2026-09-11.relationships-v1', tier: 'verified-full-text', flagged: false, relationshipValidated: true }
    expect(evidenceVerdict(old).tier).toBe('verified-full-text')
  })
  it('still downgrades unstamped and unknown verdicts', () => {
    expect(evidenceVerdict({ tier: 'verified-full-text', flagged: false }).tier).toBe('legacy-unchecked')
    expect(evidenceVerdict({ verificationVersion: 'x', tier: 'verified-estimate', flagged: false, relationshipValidated: true }).tier).toBe('legacy-unchecked')
  })
})
