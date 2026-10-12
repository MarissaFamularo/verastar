// Reproductions from the 2026-10-12 owner review of primary-outcome identification.
// A row is the declared primary only when its component set and timepoint are the
// declared ones. A parenthetical or method-clause timepoint still counts. A subset,
// a superset, a different timepoint, a missing timepoint, or a quote/name/location
// that merely says "primary" does not.

import { describe, it, expect } from 'vitest'
import { verify, TIERS } from './verify.js'
import { findPrimary } from './primaryResult.js'
import { isRelationshipValidated } from '../lib/evidenceVersion.js'

const UNKNOWN = { state: 'unknown', name: null, verified: false, indexes: [], basis: null }

const hr = (name, quote, location = 'Results') => ({
  quantity_type: 'single',
  name,
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
  location_hint: location,
  source_quote: quote,
})

function validated(quantity, source) {
  const verdict = verify(quantity, source)
  expect(verdict.tier, quantity.name).toBe(TIERS.ESTIMATE)
  expect(isRelationshipValidated(verdict), quantity.name).toBe(true)
  return { quantity, verdict }
}

const isValidated = (row) => isRelationshipValidated(row.verdict)

describe('declared timepoints are kept, including parenthetical and method-clause forms', () => {
  const oneYear = 'The 1-year rate was higher (HR 1.81 [1.04-3.13])'
  const thirtyDay = 'Death or stroke at 30 days was higher (HR 1.81 [1.04-3.13])'

  it('does not accept a one-year result for death or stroke (at 30 days)', () => {
    const source = `The primary end point was death or stroke (at 30 days). ${oneYear}.`
    const row = validated(hr('1-year death or stroke', oneYear), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject(UNKNOWN)
  })

  it('does not accept a one-year result for death or stroke, assessed at 30 days', () => {
    const source = `The primary end point was death or stroke, assessed at 30 days. ${oneYear}.`
    const row = validated(hr('1-year death or stroke', oneYear), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject(UNKNOWN)
  })

  it('identifies the 30-day composite once the parenthetical timepoint is kept', () => {
    const source = `The primary end point was death or stroke (at 30 days). ${thirtyDay}.`
    const row = validated(hr('30-day death or stroke', thirtyDay), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0], name: '30-day death or stroke',
    })
  })

  it('identifies the 30-day composite once the assessed-at timepoint is kept', () => {
    const source = `The primary end point was death or stroke, assessed at 30 days. ${thirtyDay}.`
    const row = validated(hr('Death or stroke at 30 days', thirtyDay), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
  })
})

describe('a superset composite is not the declared primary', () => {
  const quote = 'The rate was higher (HR 1.81 [1.04-3.13])'
  const source = `The primary end point was death or stroke at 30 days. ${quote}.`

  it('does not accept death, stroke, or major bleeding for death or stroke', () => {
    const row = validated(hr('30-day death or stroke or major bleeding', quote), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject(UNKNOWN)
  })

  it('still identifies the declared composite itself', () => {
    const row = validated(hr('30-day death or stroke', quote), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
  })
})

describe('quote, name, and location labels do not bypass the declared endpoint', () => {
  const shared = 'The primary end point was death or stroke at 30 days; stroke alone had HR 1.81 [1.04-3.13].'
  const alone = 'Stroke alone had HR 1.81 [1.04-3.13].'
  const declared = `The primary end point was death or stroke at 30 days. ${alone}`

  it('does not promote stroke alone because the quote names the primary endpoint', () => {
    const row = validated(hr('30-day stroke', shared), shared)
    expect(findPrimary([row], isValidated, shared)).toMatchObject(UNKNOWN)
  })

  it('does not promote stroke alone because the name says primary', () => {
    const row = validated(hr('Primary outcome: 30-day stroke', alone), declared)
    expect(findPrimary([row], isValidated, declared)).toMatchObject(UNKNOWN)
  })

  it('does not promote stroke alone because the location says primary', () => {
    const row = validated(hr('30-day stroke', alone, 'Results, primary outcome'), declared)
    expect(findPrimary([row], isValidated, declared)).toMatchObject(UNKNOWN)
  })

  it('identifies the row whose own endpoint is the declared composite', () => {
    const quote = 'Death or stroke at 30 days had HR 1.81 [1.04-3.13].'
    const source = `The primary end point was death or stroke at 30 days. ${quote}`
    const row = validated(hr('Primary end point: death or stroke at 30 days', quote, 'Results, primary outcome'), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
  })

  it('stays unidentified when a parenthetical timepoint cannot be parsed', () => {
    const source = 'The primary end point was death or stroke (at 30 days, intention-to-treat).'
    expect(findPrimary([{ quantity: hr('Primary outcome: 30-day death or stroke', alone), verdict: { flagged: false } }], () => true, source)).toMatchObject(UNKNOWN)
    expect(findPrimary([{ quantity: hr('30-day death or stroke', alone), verdict: { flagged: false } }], () => true, source)).toMatchObject(UNKNOWN)
  })
})

function strictSubsets(items) {
  const out = []
  for (let mask = 1; mask < (1 << items.length) - 1; mask++) {
    out.push(items.filter((_, index) => mask & (1 << index)))
  }
  return out
}

function joined(parts) {
  if (parts.length < 2) return parts.join(' or ')
  if (parts.length === 2) return parts.join(' or ')
  return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`
}

function atPhrase(time) {
  const [count, unit] = time.split('-')
  return `at ${count} ${count === '1' ? unit : `${unit}s`}`
}

const WRONG_TIME = {
  '30-day': ['1-year', '90-day', '12-month'],
  '1-year': ['30-day', '90-day', '12-month'],
}

const ENDPOINTS = [
  { label: 'death or stroke at 30 days', source: 'The primary end point was death or stroke at 30 days.', components: ['death', 'stroke'], time: '30-day' },
  { label: 'parenthetical (at 30 days)', source: 'The primary end point was death or stroke (at 30 days).', components: ['death', 'stroke'], time: '30-day' },
  { label: 'assessed at 30 days', source: 'The primary end point was death or stroke, assessed at 30 days.', components: ['death', 'stroke'], time: '30-day' },
  { label: 'parenthetical (at 1 year)', source: 'The primary end point was death or stroke (at 1 year).', components: ['death', 'stroke'], time: '1-year' },
  { label: 'measured at 1 year', source: 'The primary end point was death or stroke, measured at 1 year.', components: ['death', 'stroke'], time: '1-year' },
  { label: 'composite at 30 days', source: 'The primary end point was a composite of death, myocardial infarction, or stroke at 30 days.', components: ['death', 'myocardial infarction', 'stroke'], time: '30-day' },
  { label: 'death or stroke with no timepoint', source: 'The primary end point was death or stroke.', components: ['death', 'stroke'], time: null },
]

function propertyCases() {
  const cases = []
  const add = (spec, kind, name, state) => {
    cases.push({ id: `${spec.label} / ${kind} / ${name}`, source: spec.source, name, state })
  }
  for (const spec of ENDPOINTS) {
    const extra = [...spec.components, 'major bleeding']
    for (const subset of strictSubsets(spec.components)) {
      add(spec, 'subset', joined(subset), 'unknown')
      if (spec.time) add(spec, 'subset', `${spec.time} ${joined(subset)}`, 'unknown')
    }
    add(spec, 'superset', joined(extra), 'unknown')
    add(spec, 'superset', extra.join(' or '), 'unknown')
    add(spec, 'superset', `${joined(extra)} or rehospitalization`, 'unknown')
    if (spec.time) {
      add(spec, 'superset', `${spec.time} ${joined(extra)}`, 'unknown')
      add(spec, 'superset', `${joined(extra)} ${atPhrase(spec.time)}`, 'unknown')
      add(spec, 'missing timepoint', joined(spec.components), 'unknown')
      for (const wrong of WRONG_TIME[spec.time]) {
        add(spec, 'wrong timepoint', `${wrong} ${joined(spec.components)}`, 'unknown')
        add(spec, 'wrong timepoint', `${joined(spec.components)} ${atPhrase(wrong)}`, 'unknown')
      }
      add(spec, 'exact', `${spec.time} ${joined(spec.components)}`, 'identified')
      add(spec, 'exact', `${joined(spec.components)} ${atPhrase(spec.time)}`, 'identified')
      add(spec, 'exact', `${joined(spec.components)} (${atPhrase(spec.time)})`, 'identified')
    } else {
      add(spec, 'exact', joined(spec.components), 'identified')
      add(spec, 'exact', `2-year ${joined(spec.components)}`, 'identified')
    }
  }
  add(
    { label: 'death or stroke at 30 days', source: 'The primary end point was death or stroke at 30 days.' },
    'exact',
    '30-day stroke or death',
    'identified',
  )
  return cases
}

const row = (name) => ({
  quantity: {
    name,
    source_quote: '',
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

describe('endpoint equality across subsets, supersets, and timepoints', () => {
  it.each(propertyCases())('$id', ({ source, name, state }) => {
    const primary = findPrimary([row(name)], () => true, source)
    if (state === 'identified') {
      expect(primary, name).toMatchObject({ state: 'identified', basis: 'source' })
    } else {
      expect(primary, name).toMatchObject(UNKNOWN)
    }
  })
})
