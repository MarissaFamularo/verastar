// Independent reviewer regressions. All wording and values are synthetic.
import { describe, it, expect } from 'vitest'
import { verify, TIERS } from './verify.js'
const tuple = 'rate ratio (RR) 1.16 (95% CI 0.86-1.57; P=0.33)'
const quantity = (quote, unit = 'rate ratio', overrides = {}) => ({ name: 'Synthetic outcome', quantity_type: 'single', value: 1.16, unit, ci_low: 0.86, ci_high: 1.57, p_value: 0.33, source_quote: quote, ...overrides })
describe('tuple-local RR definition', () => {
  for (const unit of ['rate ratio', 'RR', 'incidence rate ratio']) {
    it(`honors the explicit definition for ${unit} without endpoint validation`, () => {
      const v = verify(quantity(tuple, unit), tuple)
      expect(v.tier).toBe(TIERS.ESTIMATE)
      expect(v.endpointValidated).toBe(false)
    })
  }
  for (const text of [
    tuple.replace('(RR)', '[RR]'),
    tuple.replace('rate ratio', 'incidence rate ratio'),
    tuple.replace('rate ratio (RR)', 'risk ratio (RR)'),
    tuple.replace('rate ratio (RR)', 'incidence rate ratio (IRR)'),
  ]) it(`preserves valid printed measures: ${text}`, () => {
    const unit = text.startsWith('risk') ? 'risk ratio' : 'rate ratio'
    expect(verify(quantity(text, unit), text).tier).toBe(TIERS.ESTIMATE)
  })
  for (const unit of ['risk ratio', 'relative risk', 'HR', 'OR']) it(`refuses conflicting declared ${unit}`, () => {
    expect(verify(quantity(tuple, unit), tuple).tier).not.toBe(TIERS.ESTIMATE)
  })
  for (const text of [tuple.replace('(RR)', '(OR)'), tuple.replace('rate ratio', 'hazard ratio')]) it(`refuses conflicting definition: ${text}`, () => {
    expect(verify(quantity(text), text).tier).not.toBe(TIERS.ESTIMATE)
  })
  for (const prefix of ['', 'Rate ratio (RR) was our measure. ', 'Another trial defined rate ratio (RR). ', 'Risk ratio (RR) was used in a cited trial. ']) it(`does not borrow a nearby definition: ${prefix}`, () => {
    const bare = tuple.replace('rate ratio (RR)', 'RR')
    expect(verify(quantity(bare), prefix + bare).tier).not.toBe(TIERS.ESTIMATE)
  })
  it('does not recover an inline declaration truncated from the quote', () => {
    const truncated = tuple.slice('rate ratio ('.length)
    expect(verify(quantity(truncated), tuple).tier).not.toBe(TIERS.ESTIMATE)
  })
  it('keeps tables unresolved', () => {
    expect(verify(quantity(tuple), { tables: tuple }).tier).not.toBe(TIERS.ESTIMATE)
  })
  it('keeps repeated tuples unresolved', () => {
    expect(verify(quantity(tuple), tuple + '. ' + tuple).tier).not.toBe(TIERS.ESTIMATE)
  })
  for (const overrides of [{ ci_high: 1.58 }, { p_value: 0.34 }]) it('refuses wrong tuple numbers', () => {
    expect(verify(quantity(tuple, 'rate ratio', overrides), tuple).tier).not.toBe(TIERS.ESTIMATE)
  })
  for (const tail of [' for interaction', ' for trend', ' (Table 2; P for interaction)']) it(`does not hide a qualified P beyond a cut-off quote: ${tail}`, () => {
    expect(verify(quantity(tuple), tuple + tail).tier).not.toBe(TIERS.ESTIMATE)
  })
})
