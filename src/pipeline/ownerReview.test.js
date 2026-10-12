// Owner review of PR #11. Each case is the one the review reproduced.
// A component, a different timepoint, or a shared quote must not become the primary.
// An interval the source did not call a CI must not be rendered as one.

import { describe, it, expect } from 'vitest'
import { verify, TIERS } from './verify.js'
import { findPrimary } from './primaryResult.js'
import { fmtNum, ciLabel } from '../lib/format.js'
import { isRelationshipValidated } from '../lib/evidenceVersion.js'

const row = (name, quote = '') => ({
  quantity: {
    name,
    source_quote: quote,
    location_hint: 'Results',
    quantity_type: 'single',
    value: null,
    ci_low: null,
    ci_high: null,
    unit: null,
    p_value: null,
  },
  verdict: { flagged: true },
})

describe('a composite primary keeps every component and its timepoint', () => {
  const source = 'The primary end point was death or stroke at 30 days.'
  const rows = [
    row('Stroke', 'Death or stroke at 30 days occurred in 4%, and stroke was the larger share.'),
    row('One-year mortality'),
    row('1-year mortality'),
    row('Death'),
    row('30-day stroke'),
    row('Death or stroke at 1 year'),
    row('12-month death or stroke'),
    row('Death or stroke at 30 days'),
    row('30-day death or stroke'),
  ]

  it('does not identify a component or a different timepoint as the 30-day composite', () => {
    const primary = findPrimary(rows, () => true, source)
    expect(primary).toMatchObject({ state: 'identified', basis: 'source', verified: true })
    expect(primary.indexes).toEqual([7, 8])
    expect(primary.name).toBe('Death or stroke at 30 days')
    for (const name of ['Stroke', 'One-year mortality', '1-year mortality', 'Death', '30-day stroke', 'Death or stroke at 1 year', '12-month death or stroke']) {
      expect(findPrimary([row(name)], () => true, source)).toMatchObject({ state: 'unknown', verified: false, indexes: [] })
    }
  })
})

describe('a quote that mentions the primary does not promote another result', () => {
  const quote = 'All-cause mortality was higher (HR 1.81 [1.04-3.13]) in the group without amputation-free survival'
  const source = `The primary outcome was amputation-free survival. ${quote}.`
  const mortality = {
    quantity_type: 'single',
    name: 'All-cause mortality',
    unit: 'HR',
    value: 1.81,
    ci_low: 1.04,
    ci_high: 3.13,
    p_value: null,
    range_low: null,
    range_high: null,
    first_label: null,
    first_value: null,
    second_label: null,
    second_value: null,
    location_hint: 'Results',
    source_quote: quote,
  }

  it('verifies the mortality hazard ratio and still does not call it the primary', () => {
    const verdict = verify(mortality, source)
    expect(verdict.tier).toBe(TIERS.ESTIMATE)
    expect(isRelationshipValidated(verdict)).toBe(true)
    const primary = findPrimary([{ quantity: mortality, verdict }], (r) => isRelationshipValidated(r.verdict), source)
    expect(primary).toMatchObject({ state: 'unknown', verified: false, indexes: [] })
  })

  it('identifies the row whose own name is the declared endpoint', () => {
    const named = { ...mortality, name: 'Amputation-free survival' }
    const verdict = verify(named, source)
    expect(isRelationshipValidated(verdict)).toBe(true)
    expect(findPrimary([{ quantity: named, verdict }], (r) => isRelationshipValidated(r.verdict), source)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0], name: 'Amputation-free survival',
    })
  })
})

describe('an unlabelled interval uses the verifier wrap, and CI only when labelled', () => {
  const estimate = (quote) => ({
    quantity_type: 'single',
    name: 'major amputation',
    unit: 'HR',
    value: 1.81,
    ci_low: 1.04,
    ci_high: 3.13,
    p_value: null,
    range_low: null,
    range_high: null,
    first_label: null,
    first_value: null,
    second_label: null,
    second_value: null,
    location_hint: 'Results',
    source_quote: quote,
  })

  it.each([
    'HR 1.81 (1.04–3.13)',
    'HR 1.81 [ 1.04 - 3.13 ]',
    'HR 1.81 [1.04-3.13]',
  ])('accepts %s and renders interval, not CI', (quote) => {
    const quantity = estimate(quote)
    const verdict = verify(quantity, quote)
    expect(verdict.tier).toBe(TIERS.ESTIMATE)
    expect(verdict.reason).toMatch(/did not label the interval as a confidence interval/)
    expect(ciLabel(quantity)).toBe('interval')
    expect(fmtNum(quantity)).toBe('1.81 HR (interval 1.04–3.13)')
    expect(fmtNum(quantity)).not.toContain('(CI ')
  })

  it('still says CI when the source labels the interval', () => {
    const quantity = estimate('HR 1.81 (95% CI 1.04-3.13)')
    expect(verify(quantity, quantity.source_quote).tier).toBe(TIERS.ESTIMATE)
    expect(ciLabel(quantity)).toBe('CI')
    expect(fmtNum(quantity)).toBe('1.81 HR (CI 1.04–3.13)')
    expect(ciLabel({ source_quote: '95% CI, 0.7 to 0.9' })).toBe('CI')
  })
})

function strictSubsets(items) {
  const out = []
  for (let mask = 1; mask < (1 << items.length) - 1; mask++) {
    out.push(items.filter((_, index) => mask & (1 << index)))
  }
  return out
}

const hr = (name, quote) => ({
  quantity_type: 'single', name, unit: 'HR', value: 1.81, ci_low: 1.04, ci_high: 3.13,
  p_value: null, range_low: null, range_high: null, first_label: null, first_value: null,
  second_label: null, second_value: null, location_hint: 'Results', source_quote: quote,
})

describe('comma lists and abbreviations are one composite', () => {
  const miQuote = 'Myocardial infarction was higher (HR 1.81 [1.04-3.13])'
  const compositeSource = `The primary end point was a composite of death, myocardial infarction, or stroke at 30 days. ${miQuote}.`
  const abbrevQuote = 'MI was higher (HR 1.81 [1.04-3.13])'
  const abbrevSource = `The primary end point was death or myocardial infarction (MI) at 30 days. ${abbrevQuote}.`

  it('does not identify myocardial infarction alone, with the real verifier', () => {
    const quantity = hr('Myocardial infarction', miQuote)
    const verdict = verify(quantity, compositeSource)
    expect(verdict.tier).toBe(TIERS.ESTIMATE)
    expect(isRelationshipValidated(verdict)).toBe(true)
    expect(findPrimary([{ quantity, verdict }], (entry) => isRelationshipValidated(entry.verdict), compositeSource)).toMatchObject({
      state: 'unknown', verified: false, indexes: [],
    })
  })

  it('does not identify 30-day MI alone, with the real verifier', () => {
    const quantity = hr('30-day MI', abbrevQuote)
    const verdict = verify(quantity, abbrevSource)
    expect(verdict.tier).toBe(TIERS.ESTIMATE)
    expect(isRelationshipValidated(verdict)).toBe(true)
    expect(findPrimary([{ quantity, verdict }], (entry) => isRelationshipValidated(entry.verdict), abbrevSource)).toMatchObject({
      state: 'unknown', verified: false, indexes: [],
    })
  })

  it('identifies the full composite when that row is the verified result', () => {
    const quantity = hr('Death, myocardial infarction, or stroke at 30 days', miQuote)
    const verdict = verify(quantity, compositeSource)
    expect(isRelationshipValidated(verdict)).toBe(true)
    expect(findPrimary([{ quantity, verdict }], (entry) => isRelationshipValidated(entry.verdict), compositeSource)).toMatchObject({
      state: 'identified', basis: 'source', verified: true,
    })
    const named = hr('30-day death or MI', abbrevQuote)
    const namedVerdict = verify(named, abbrevSource)
    expect(findPrimary([{ quantity: named, verdict: namedVerdict }], (entry) => isRelationshipValidated(entry.verdict), abbrevSource)).toMatchObject({
      state: 'identified', basis: 'source', verified: true,
    })
  })

  it('keeps a plural outcome list as separate endpoints and withholds a combination or a list joined by or', () => {
    const listed = 'Primary outcomes were wound healing, major amputation, and major adverse limb events (MALE).'
    expect(findPrimary([row('Two-year major amputation')], () => true, listed)).toMatchObject({ state: 'identified' })
    expect(findPrimary([row('Two-year MALE')], () => true, listed)).toMatchObject({ state: 'identified' })
    expect(findPrimary([row('wound healing and major amputation')], () => true, listed)).toMatchObject({ state: 'unknown', verified: false })
    const mixed = 'Primary outcomes were death, myocardial infarction, or stroke at 30 days.'
    expect(findPrimary([row('30-day death, myocardial infarction, or stroke')], () => true, mixed)).toMatchObject({ state: 'unknown', verified: false })
    expect(findPrimary([row('Myocardial infarction')], () => true, mixed)).toMatchObject({ state: 'unknown', verified: false })
  })
})

describe('every strict subset and every wrong timepoint of a composite is unidentified', () => {
  const wrongTime = { '30-day': ['1-year', '90-day', '12-month'], '1-year': ['30-day', '90-day', '12-month'] }
  const composites = [
    { phrase: 'death or stroke', components: ['death', 'stroke'], time: null },
    { phrase: 'death and stroke', components: ['death', 'stroke'], time: null },
    { phrase: 'death and/or stroke', components: ['death', 'stroke'], time: null },
    { phrase: 'death and / or stroke at 30 days', components: ['death', 'stroke'], time: '30-day' },
    { phrase: 'a composite of death or stroke at 30 days', components: ['death', 'stroke'], time: '30-day' },
    { phrase: 'a composite of death, myocardial infarction, or stroke at 30 days', components: ['death', 'myocardial infarction', 'stroke'], time: '30-day' },
    { phrase: 'death, myocardial infarction, and stroke', components: ['death', 'myocardial infarction', 'stroke'], time: null },
    { phrase: 'death, myocardial infarction, stroke, or major bleeding at 1 year', components: ['death', 'myocardial infarction', 'stroke', 'major bleeding'], time: '1-year' },
    { phrase: 'death or myocardial infarction (MI) at 30 days', components: ['death', 'myocardial infarction'], time: '30-day', synonyms: { 'myocardial infarction': 'MI' } },
    { phrase: '30-day composite of death, myocardial infarction (MI), or stroke', components: ['death', 'myocardial infarction', 'stroke'], time: '30-day', synonyms: { 'myocardial infarction': 'MI' } },
  ]

  it.each(composites)('$phrase', ({ phrase, components, time, synonyms = {} }) => {
    const source = `The primary end point was ${phrase}.`
    const render = (parts, prefix) => {
      const text = parts.map((part) => synonyms[part] || part).join(' or ')
      return prefix ? `${prefix} ${text}` : text
    }
    for (const subset of strictSubsets(components)) {
      expect(findPrimary([row(render(subset))], () => true, source).state, render(subset)).toBe('unknown')
      expect(findPrimary([row(subset.join(' or '))], () => true, source).state, subset.join(' or ')).toBe('unknown')
      if (time) expect(findPrimary([row(render(subset, time))], () => true, source).state, render(subset, time)).toBe('unknown')
    }
    const spelled = time ? `${time} ${components.join(' or ')}` : components.join(' or ')
    const withSynonym = render(components, time)
    expect(findPrimary([row(spelled)], () => true, source), spelled).toMatchObject({ state: 'identified', basis: 'source' })
    expect(findPrimary([row(withSynonym)], () => true, source), withSynonym).toMatchObject({ state: 'identified', basis: 'source' })
    if (time) {
      expect(findPrimary([row(components.join(' or '))], () => true, source).state).toBe('unknown')
      for (const prefix of wrongTime[time]) {
        const named = render(components, prefix)
        expect(findPrimary([row(named)], () => true, source).state, named).toBe('unknown')
        expect(findPrimary([row(`${prefix} ${components.join(' or ')}`)], () => true, source).state).toBe('unknown')
      }
    } else {
      expect(findPrimary([row(render(components, 'Two-year'))], () => true, source)).toMatchObject({ state: 'identified' })
    }
  })
})
