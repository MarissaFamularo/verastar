import { describe, it, expect } from 'vitest'
import { verify } from './verify.js'
import { relationshipCases } from './relationshipFixtures.js'
describe('relationship verification regression', () => {
  for (const fixture of relationshipCases) it(fixture.label, () => {
    const verdict = verify(fixture.quantity, fixture.source)
    expect(verdict.flagged).toBe(!fixture.validated)
    expect(verdict.relationshipValidated).toBe(fixture.validated)
    if (!fixture.validated) expect(verdict.tier === 'verified-full-text' || verdict.tier === 'verified-registry').toBe(false)
  })
  it('numeric registry collision cannot upgrade a different endpoint', () => {
    const verdict = verify({ name: 'Mortality', value: 10, unit: '%', source_quote: 'Mortality was 10%.' }, 'Mortality was 10%.', { registry: [{ measure: 'Stroke', value: 10 }] })
    expect(verdict.tier).toBe('verified-full-text')
  })
})

describe('complete registry identity and supported sentence boundaries', () => {
  const name = 'Mortality in adults at 30 days'
  const quantity = { name, value: 10, unit: '%', population: 'adults', timepoint: '30 days', source_quote: `${name} was 10%.` }
  const row = { measure: name, value: 10, unit: '%', population: 'adults', timepoint: '30 days' }
  it('upgrades only a complete exact registry identity', () => {
    expect(verify(quantity, quantity.source_quote, { registry: [row] }).tier).toBe('verified-registry')
  })
  for (const [field, value] of [['measure', 'Stroke'], ['unit', 'mg'], ['timepoint', '60 days'], ['population', 'children'], ['ci_high', 10]]) {
    it(`withholds registry upgrade for a different ${field}`, () => {
      expect(verify(quantity, quantity.source_quote, { registry: [{ ...row, [field]: value }] }).tier).toBe('verified-full-text')
    })
  }
  it('does not upgrade when a registry identity field is missing', () => {
    expect(verify(quantity, quantity.source_quote, { registry: [{ ...row, timepoint: null }] }).tier).toBe('verified-full-text')
  })
  it('validates a complete abstract sentence without claiming full-text evidence', () => {
    expect(verify(quantity, quantity.source_quote, { sourceTier: 'abstract_only' }).tier).toBe('abstract-only')
  })
  it('retains numeric normalization for a relationship control', () => {
    const source = 'Mortality was 10·00%.'
    expect(verify({ name: 'Mortality', value: 10, unit: '%', source_quote: source }, source).relationshipValidated).toBe(true)
  })
  it('does not turn partial coverage into a scalar claim', () => {
    expect(verify({ name: 'Mortality', value: 10, unit: '%', source_quote: 'Mortality was 10%' }, 'Mortality was 10% at 60 days.').relationshipValidated).toBe(false)
  })
  it('preserves located source evidence for a swapped claim without asserting it', () => {
    const fixture = relationshipCases.find((item) => item.label === 'swapped arms')
    const verdict = verify(fixture.quantity, fixture.source)
    expect(verdict.tier).toBe('source-located')
    expect(verdict.sourceLocated).toBe(true)
    expect(verdict.numericCoverage).toBe(true)
    expect(verdict.relationshipStatus).toBe('unresolved')
  })
})

describe('extra claim qualifiers cannot bypass binding', () => {
  const base = { name: 'Mortality', value: 10, unit: '%', source_quote: 'Mortality was 10%.' }
  for (const fields of [{ population: 'children' }, { timepoint: '60 days' }, { direction: 'decreased' }, { endpoint: 'Stroke' }, { subgroup: 'women' }]) {
    it(`withholds an additional unbound qualifier ${Object.keys(fields)[0]}`, () => {
      expect(verify({ ...base, ...fields }, base.source_quote).relationshipValidated).toBe(false)
    })
  }
  it('does not treat one population substring as a pooled population', () => {
    const quantity = { ...base, name: 'Mortality in women and men', population: 'men', source_quote: 'Mortality in women and men was 10%.' }
    expect(verify(quantity, quantity.source_quote).relationshipValidated).toBe(false)
  })
  it('checks an explicit direction field against the source verb', () => {
    const quantity = { name: 'Mortality', quantity_type: 'change', first_value: 20, second_value: 10, unit: '%', direction: 'increased', source_quote: 'Mortality decreased from 20% to 10%.' }
    expect(verify(quantity, quantity.source_quote).relationshipValidated).toBe(false)
    expect(verify({ ...quantity, direction: 'decreased' }, quantity.source_quote).relationshipValidated).toBe(true)
  })
})
