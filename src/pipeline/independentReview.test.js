// Reproductions from the 2026-10-12 owner review of primary-outcome identification.
// A row is the declared primary only when each component matches, qualifiers bound
// to that component and window included. A window is relation, duration, and anchor.
// A parenthetical or bracket is a time window, a pure abbreviation, or part of the
// component; it is never dropped and a qualifier never moves to another outcome.
// A window is shared only when the phrase puts one window on the whole endpoint.
// "within" is not "at". A named anchor is not an absent or different anchor.
// A subset, a superset, a different window, or a quote/name/location that merely
// says "primary" does not match. A component has to be one outcome from a closed
// list plus recognized qualifier phrases. An unfamiliar word leaves a different
// phrase unidentified; the matcher does not turn it into another outcome. The
// same phrase matches after case, whitespace, and punctuation are normalized.

import { describe, it, expect } from 'vitest'
import { verify, TIERS } from './verify.js'
import { findPrimary, PRIMARY_AMBIGUOUS_REASON, PRIMARY_UNBOUND_REASON, PRIMARY_UNRECOGNIZED_REASON } from './primaryResult.js'
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

describe('a qualifier or a bracketed outcome is part of the endpoint', () => {
  it('does not accept unrestricted death for death (cardiovascular only)', () => {
    const quote = 'Death was higher (HR 1.81 [1.04-3.13])'
    const source = `The primary end point was death (cardiovascular only). ${quote}.`
    const row = validated(hr('Death', quote), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject(UNKNOWN)
  })

  it('identifies cardiovascular death, including the same parenthetical', () => {
    const quote = 'Cardiovascular death was higher (HR 1.81 [1.04-3.13])'
    const source = `The primary end point was death (cardiovascular only). ${quote}.`
    const spelled = validated(hr('cardiovascular death', quote), source)
    expect(findPrimary([spelled], isValidated, source)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0], name: 'cardiovascular death',
    })
    const paren = validated(hr('death (cardiovascular only)', quote), source)
    expect(findPrimary([paren], isValidated, source)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
  })

  it('does not drop an extra outcome written in square brackets', () => {
    const quote = 'The composite was higher (HR 1.81 [1.04-3.13])'
    const source = `The primary end point was death or stroke [major bleeding]. ${quote}.`
    const row = validated(hr('death or stroke', quote), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject(UNKNOWN)
  })

  it('identifies the bracketed composite, spelled out or still in brackets', () => {
    const quote = 'The composite was higher (HR 1.81 [1.04-3.13])'
    const source = `The primary end point was death or stroke [major bleeding]. ${quote}.`
    const spelled = validated(hr('death or stroke or major bleeding', quote), source)
    expect(findPrimary([spelled], isValidated, source)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
    const bracketed = validated(hr('death or stroke [major bleeding]', quote), source)
    expect(findPrimary([bracketed], isValidated, source)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
  })
})

describe('a window belongs to the component it is written on', () => {
  const quote = 'The 1-year rate was higher (HR 1.81 [1.04-3.13])'
  const source = `The primary end point was death within 30 days or ipsilateral stroke at one year. ${quote}.`

  it('does not extend early death across the one-year stroke window', () => {
    const row = validated(hr('1-year death or ipsilateral stroke', quote), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject(UNKNOWN)
  })

  it('identifies the row that keeps each component window and the ipsilateral qualifier', () => {
    const row = validated(hr('Death within 30 days or ipsilateral stroke at one year', quote), source)
    expect(findPrimary([row], isValidated, source)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
      name: 'Death within 30 days or ipsilateral stroke at one year',
    })
  })

  it('does not treat within 30 days as at 30 days', () => {
    const early = 'Death within 30 days was higher (HR 1.81 [1.04-3.13])'
    const declared = `The primary end point was death within 30 days. ${early}.`
    expect(findPrimary([validated(hr('30-day death', early), declared)], isValidated, declared)).toMatchObject(UNKNOWN)
    expect(findPrimary([validated(hr('death at 30 days', early), declared)], isValidated, declared)).toMatchObject(UNKNOWN)
    expect(findPrimary([validated(hr('death within 30 days', early), declared)], isValidated, declared)).toMatchObject({
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
  const qualifier = { label: 'cardiovascular qualifier', source: 'The primary end point was death (cardiovascular only).' }
  add(qualifier, 'dropped qualifier', 'death', 'unknown')
  add(qualifier, 'dropped qualifier', '2-year death', 'unknown')
  add(qualifier, 'superset', 'cardiovascular death or stroke', 'unknown')
  add(qualifier, 'exact', 'cardiovascular death', 'identified')
  add(qualifier, 'exact', 'death (cardiovascular only)', 'identified')
  add(qualifier, 'exact', 'death [cardiovascular only]', 'identified')

  const bracket = { label: 'bracketed major bleeding', source: 'The primary end point was death or stroke [major bleeding].' }
  add(bracket, 'dropped bracket', 'death or stroke', 'unknown')
  add(bracket, 'dropped bracket', '30-day death or stroke', 'unknown')
  add(bracket, 'subset', 'major bleeding', 'unknown')
  add(bracket, 'superset', 'death or stroke or major bleeding or rehospitalization', 'unknown')
  add(bracket, 'exact', 'death or stroke or major bleeding', 'identified')
  add(bracket, 'exact', 'death, stroke, or major bleeding', 'identified')
  add(bracket, 'exact', 'death or stroke [major bleeding]', 'identified')

  const bracketTime = { label: 'bracket timepoint [at 30 days]', source: 'The primary end point was death or stroke [at 30 days].' }
  add(bracketTime, 'wrong timepoint', '1-year death or stroke', 'unknown')
  add(bracketTime, 'missing timepoint', 'death or stroke', 'unknown')
  add(bracketTime, 'subset', '30-day death', 'unknown')
  add(bracketTime, 'exact', '30-day death or stroke', 'identified')
  add(bracketTime, 'exact', 'death or stroke [at 30 days]', 'identified')
  add(bracketTime, 'exact', 'death or stroke (at 30 days)', 'identified')

  const within = { label: 'within 30 days', source: 'The primary end point was death within 30 days.' }
  add(within, 'within is not at', '30-day death', 'unknown')
  add(within, 'within is not at', 'death at 30 days', 'unknown')
  add(within, 'wrong timepoint', 'death within 1 year', 'unknown')
  add(within, 'missing timepoint', 'death', 'unknown')
  add(within, 'exact', 'death within 30 days', 'identified')
  add(within, 'exact', 'death (within 30 days)', 'identified')

  const perComponent = {
    label: 'per-component windows',
    source: 'The primary end point was death within 30 days or ipsilateral stroke at one year.',
  }
  add(perComponent, 'shared window', '1-year death or ipsilateral stroke', 'unknown')
  add(perComponent, 'shared window', 'death or ipsilateral stroke at one year', 'unknown')
  add(perComponent, 'within is not at', 'death at 30 days or ipsilateral stroke at one year', 'unknown')
  add(perComponent, 'within is not at', '30-day death or ipsilateral stroke at 1 year', 'unknown')
  add(perComponent, 'dropped qualifier', 'death within 30 days or stroke at one year', 'unknown')
  add(perComponent, 'subset', 'death within 30 days', 'unknown')
  add(perComponent, 'subset', 'ipsilateral stroke at one year', 'unknown')
  add(perComponent, 'exact', 'death within 30 days or ipsilateral stroke at one year', 'identified')
  add(perComponent, 'exact', 'death (within 30 days) or ipsilateral stroke at one year', 'identified')
  add(perComponent, 'exact', 'death within 30 days or 1-year ipsilateral stroke', 'identified')

  const parenWindows = {
    label: 'parenthetical per-component windows',
    source: 'The primary end point was death (within 30 days) or ipsilateral stroke at one year.',
  }
  add(parenWindows, 'shared window', '1-year death or ipsilateral stroke', 'unknown')
  add(parenWindows, 'within is not at', '30-day death or ipsilateral stroke at one year', 'unknown')
  add(parenWindows, 'exact', 'death within 30 days or ipsilateral stroke at one year', 'identified')
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

describe('endpoint equality across subsets, supersets, qualifiers, brackets, and windows', () => {
  it.each(propertyCases())('$id', ({ source, name, state }) => {
    const primary = findPrimary([row(name)], () => true, source)
    if (state === 'identified') {
      expect(primary, name).toMatchObject({ state: 'identified', basis: 'source' })
    } else {
      expect(primary, name).toMatchObject(UNKNOWN)
    }
  })
})

describe('a qualifier stays on its outcome, and a window keeps its anchor', () => {
  const quote = 'The endpoint was higher (HR 1.81 [1.04-3.13])'
  const check = (declared, name) => {
    const source = `The primary end point was ${declared}. ${quote}.`
    return findPrimary([validated(hr(name, quote), source)], isValidated, source)
  }

  it('does not match when requiring hospitalization moves from MI onto stroke', () => {
    const declared = 'MI requiring hospitalization, or stroke'
    expect(check(declared, 'MI, or stroke requiring hospitalization')).toMatchObject(UNKNOWN)
    expect(check(declared, 'MI or stroke (requiring hospitalization)')).toMatchObject(UNKNOWN)
    expect(check('MI (requiring hospitalization), or stroke', 'MI or stroke (requiring hospitalization)')).toMatchObject(UNKNOWN)
    expect(check('MI [requiring hospitalization], or stroke', 'MI, or stroke [requiring hospitalization]')).toMatchObject(UNKNOWN)
    expect(check('MI, requiring hospitalization, or stroke', 'MI or stroke, requiring hospitalization')).toMatchObject(UNKNOWN)
    expect(check(declared, 'MI requiring hospitalization or stroke')).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
    expect(check('MI (requiring hospitalization), or stroke', 'MI (requiring hospitalization) or stroke')).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
  })

  it('does not match when the anchor is surgery, or when the anchor is absent', () => {
    const declared = 'Death within 30 days after randomization'
    expect(check(declared, 'Death within 30 days after surgery')).toMatchObject(UNKNOWN)
    expect(check(declared, 'Death within 30 days')).toMatchObject(UNKNOWN)
    expect(check(declared, 'Death at 30 days after randomization')).toMatchObject(UNKNOWN)
    expect(check(declared, 'Death within 90 days after randomization')).toMatchObject(UNKNOWN)
    expect(check(declared, 'Death within 30 days after randomization')).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
    expect(check(declared, 'death within 30 days after the randomization')).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
  })

  it('does not treat leading to hospitalization as an outcome that can move', () => {
    const declared = 'MI leading to hospitalization, or stroke'
    expect(check(declared, 'MI, or stroke leading to hospitalization')).toMatchObject(UNKNOWN)
    expect(check(declared, declared)).toMatchObject({
      state: 'identified', basis: 'source', verified: true, indexes: [0],
    })
    expect(check('MI, leading to hospitalization, or stroke', 'MI, or stroke, leading to hospitalization')).toMatchObject(UNKNOWN)
    expect(check('MI (leading to hospitalization), or stroke', 'MI or stroke (leading to hospitalization)')).toMatchObject(UNKNOWN)
    expect(check('MI [leading to hospitalization], or stroke', 'MI, or stroke [leading to hospitalization]')).toMatchObject(UNKNOWN)
  })
})

const UNFAMILIAR_CONNECTORS = [
  'leading to',
  'resulting in',
  'due to',
  'causing',
  'with',
  'associated with',
  'related to',
  'secondary to',
  'followed by',
  'complicated by',
  'progressing to',
  'presenting with',
  'manifesting as',
  'attributed to',
  'accompanied by',
  'preceding',
  'subsequent to',
  'in the setting of',
  'as a cause of',
  'culminating in',
  'producing',
  'triggering',
  'evolving into',
  'characterized by',
]

describe('an unfamiliar connecting phrase matches only when the phrase is the same', () => {
  it.each(UNFAMILIAR_CONNECTORS)('%s', (connector) => {
    const inline = `MI ${connector} hospitalization, or stroke`
    const inlineSource = `The primary end point was ${inline}.`
    expect(findPrimary([row(inline)], () => true, inlineSource), inline).toMatchObject({
      state: 'identified', basis: 'source', indexes: [0],
    })
    expect(findPrimary([row(`MI, or stroke ${connector} hospitalization`)], () => true, inlineSource)).toMatchObject(UNKNOWN)
    const comma = `MI, ${connector} hospitalization, or stroke`
    const commaSource = `The primary end point was ${comma}.`
    expect(findPrimary([row(comma)], () => true, commaSource)).toMatchObject({
      state: 'identified', basis: 'source', indexes: [0],
    })
    expect(findPrimary([row(`MI, or stroke, ${connector} hospitalization`)], () => true, commaSource)).toMatchObject(UNKNOWN)
    const paren = `MI (${connector} hospitalization), or stroke`
    const parenSource = `The primary end point was ${paren}.`
    expect(findPrimary([row(paren)], () => true, parenSource)).toMatchObject({
      state: 'identified', basis: 'source', indexes: [0],
    })
    expect(findPrimary([row(`MI or stroke (${connector} hospitalization)`)], () => true, parenSource)).toMatchObject(UNKNOWN)
  })
})

const SLOT_ANCHOR = 'surgery'
const SLOT_DURATION = '90 days'

function cloneSlots(components) {
  return components.map((component) => ({
    head: component.head,
    qualifier: component.qualifier,
    window: component.window ? { ...component.window } : null,
  }))
}

function windowText(window) {
  if (!window) return ''
  const anchor = window.anchor ? ` after ${window.anchor}` : ''
  return ` ${window.relation} ${window.duration}${anchor}`
}

function renderComponent(component, style) {
  const timing = windowText(component.window)
  if (!component.qualifier) return `${component.head}${timing}`
  if (style === 'paren') return `${component.head} (${component.qualifier})${timing}`
  if (style === 'bracket') return `${component.head} [${component.qualifier}]${timing}`
  if (style === 'comma') return `${component.head}, ${component.qualifier}${timing}`
  return `${component.head} ${component.qualifier}${timing}`
}

function renderEndpoint(components, style) {
  const rendered = components.map((component) => renderComponent(component, style))
  if (rendered.length < 2) return rendered.join('')
  if (style === 'comma') return `${rendered[0]}, or ${rendered.slice(1).join(' or ')}`
  if (rendered.length === 2) return rendered.join(' or ')
  return `${rendered.slice(0, -1).join(', ')}, or ${rendered[rendered.length - 1]}`
}

function otherAnchor(anchor) {
  return anchor === SLOT_ANCHOR ? 'discharge' : SLOT_ANCHOR
}

function otherRelation(relation) {
  return relation === 'within' ? 'at' : 'within'
}

function otherDuration(duration) {
  return duration === '30 days' ? SLOT_DURATION : '30 days'
}

function slotPerturbations(components) {
  const found = []
  const qualifierAt = components.findIndex((component) => component.qualifier)
  if (qualifierAt >= 0 && components.length > 1) {
    const target = components.findIndex((_, index) => index !== qualifierAt)
    const moved = cloneSlots(components)
    moved[target] = { ...moved[target], qualifier: moved[qualifierAt].qualifier }
    moved[qualifierAt] = { ...moved[qualifierAt], qualifier: null }
    found.push(['move qualifier', moved])
  }
  components.forEach((component, index) => {
    if (!component.window) return
    const anchor = cloneSlots(components)
    anchor[index] = { ...anchor[index], window: { ...component.window, anchor: otherAnchor(component.window.anchor) } }
    found.push([`change anchor of ${component.head}`, anchor])
    if (component.window.anchor) {
      const dropped = cloneSlots(components)
      dropped[index] = { ...dropped[index], window: { ...component.window, anchor: '' } }
      found.push([`drop anchor of ${component.head}`, dropped])
    } else {
      const added = cloneSlots(components)
      added[index] = { ...added[index], window: { ...component.window, anchor: SLOT_ANCHOR } }
      found.push([`add anchor of ${component.head}`, added])
    }
    const relation = cloneSlots(components)
    relation[index] = { ...relation[index], window: { ...component.window, relation: otherRelation(component.window.relation) } }
    found.push([`change relation of ${component.head}`, relation])
    const duration = cloneSlots(components)
    duration[index] = { ...duration[index], window: { ...component.window, duration: otherDuration(component.window.duration) } }
    found.push([`change duration of ${component.head}`, duration])
  })
  if (components.some((component) => component.window)) {
    const host = components.findIndex((component) => !component.window)
    if (host >= 0) {
      const addedWindow = cloneSlots(components)
      addedWindow[host] = { ...addedWindow[host], window: { relation: 'at', duration: '1 year', anchor: 'discharge' } }
      found.push([`add window of ${components[host].head}`, addedWindow])
    }
  }
  found.push(['add component', [...cloneSlots(components), { head: 'major bleeding', qualifier: null, window: null }]])
  if (components.length > 1) found.push(['drop component', cloneSlots(components).slice(0, -1)])
  return found
}

const miAndStroke = [
  { head: 'MI', qualifier: 'requiring hospitalization', window: null },
  { head: 'stroke', qualifier: null, window: null },
]
const SLOT_BASES = [
  { id: 'inline qualifier', style: 'inline', components: miAndStroke },
  { id: 'parenthetical qualifier', style: 'paren', components: miAndStroke },
  { id: 'bracket qualifier', style: 'bracket', components: miAndStroke },
  { id: 'comma qualifier', style: 'comma', components: miAndStroke },
  {
    id: 'anchored death',
    style: 'inline',
    components: [
      { head: 'death', qualifier: null, window: { relation: 'within', duration: '30 days', anchor: 'randomization' } },
    ],
  },
  {
    id: 'anchored death or stroke',
    style: 'inline',
    components: [
      { head: 'death', qualifier: null, window: { relation: 'within', duration: '30 days', anchor: 'randomization' } },
      { head: 'stroke', qualifier: 'requiring hospitalization', window: null },
    ],
  },
  {
    id: 'qualified death and anchored stroke',
    style: 'paren',
    components: [
      { head: 'death', qualifier: 'requiring hospitalization', window: { relation: 'within', duration: '30 days', anchor: 'surgery' } },
      { head: 'stroke', qualifier: null, window: { relation: 'at', duration: '1 year', anchor: 'discharge' } },
    ],
  },
  {
    id: 'untimed anchor slot',
    style: 'inline',
    components: [
      { head: 'death', qualifier: null, window: { relation: 'within', duration: '30 days', anchor: '' } },
    ],
  },
]

function slotCases() {
  const cases = []
  for (const base of SLOT_BASES) {
    const declared = renderEndpoint(base.components, base.style)
    const source = `The primary end point was ${declared}.`
    cases.push({ id: `${base.id} / exact / ${declared}`, source, name: declared, state: 'identified' })
    for (const [kind, components] of slotPerturbations(base.components)) {
      const name = renderEndpoint(components, base.style)
      if (name === declared) throw new Error(`perturbation ${base.id} / ${kind} did not change the endpoint`)
      cases.push({ id: `${base.id} / ${kind} / ${name}`, source, name, state: 'unknown' })
    }
  }
  return cases
}

describe('one-slot perturbations of a parsed endpoint are unidentified', () => {
  it.each(slotCases())('$id', ({ source, name, state }) => {
    const primary = findPrimary([row(name)], () => true, source)
    if (state === 'identified') {
      expect(primary, name).toMatchObject({ state: 'identified', basis: 'source' })
    } else {
      expect(primary, name).toMatchObject(UNKNOWN)
    }
  })
})

describe('identical phrases match without dropping a qualifier, component, timepoint, population, or arm', () => {
  const identify = (declared, name) => findPrimary(
    [row(name)],
    () => true,
    `The primary end point was ${declared}.`,
  )

  it('matches death from any cause, new myocardial infarction, and hospitalization for heart failure when the phrase is the same', () => {
    for (const phrase of ['death from any cause', 'new myocardial infarction', 'hospitalization for heart failure', 'Death from any cause.', 'NEW myocardial infarction']) {
      const declared = phrase.replace(/\.$/, '')
      expect(identify(declared, phrase), phrase).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
    }
    expect(identify(
      'death from any cause or hospitalization for heart failure',
      'Primary composite outcome (death from any cause or hospitalization for heart failure), PCI vs optimal medical therapy, hazard ratio',
    )).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
    expect(identify(
      'a composite of adjudicated cardiovascular death, myocardial infarction, or ischemic stroke',
      'Primary efficacy end point (CV death, MI, or ischemic stroke), ticagrelor vs clopidogrel, hazard ratio',
    )).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
  })

  it('negative: a different qualifier does not match', () => {
    expect(identify('death from any cause', 'death')).toMatchObject(UNKNOWN)
    expect(identify('death from any cause at 1 year', 'death at 1 year')).toMatchObject(UNKNOWN)
    expect(identify('death from any cause at 1 year', '1-year death')).toMatchObject(UNKNOWN)
    expect(identify('death from any cause', 'death from cardiovascular causes')).toMatchObject(UNKNOWN)
    expect(identify('new myocardial infarction', 'myocardial infarction')).toMatchObject(UNKNOWN)
    expect(identify('new myocardial infarction', 'old myocardial infarction')).toMatchObject(UNKNOWN)
    expect(identify('ischemic stroke', 'stroke')).toMatchObject(UNKNOWN)
    expect(identify('hospitalization for heart failure', 'hospitalization')).toMatchObject(UNKNOWN)
    expect(identify('hospitalization for heart failure', 'hospitalization for stroke')).toMatchObject(UNKNOWN)
    expect(identify('CV death', 'death')).toMatchObject(UNKNOWN)
    expect(identify('death or adjudicated stroke', 'death or stroke')).toMatchObject(UNKNOWN)
  })

  it('negative: a different component does not match', () => {
    const declared = 'death from any cause or hospitalization for heart failure'
    expect(identify(declared, 'death from any cause')).toMatchObject(UNKNOWN)
    expect(identify(declared, 'hospitalization for heart failure')).toMatchObject(UNKNOWN)
    expect(identify(declared, 'death from any cause or stroke')).toMatchObject(UNKNOWN)
    expect(identify(declared, 'death from any cause or hospitalization for heart failure or stroke')).toMatchObject(UNKNOWN)
    expect(identify(
      'cardiovascular death, myocardial infarction, or ischemic stroke',
      'CV death or MI',
    )).toMatchObject(UNKNOWN)
  })

  it('negative: a different timepoint does not match', () => {
    expect(identify('death from any cause at 1 year', 'death from any cause at 30 days')).toMatchObject(UNKNOWN)
    expect(identify('death from any cause at 1 year', 'death from any cause')).toMatchObject(UNKNOWN)
    expect(identify('death from any cause', 'death from any cause at 1 year')).toMatchObject(UNKNOWN)
    expect(identify('new myocardial infarction at 30 days', 'new myocardial infarction at 1 year')).toMatchObject(UNKNOWN)
    expect(identify('hospitalization for heart failure within 30 days', 'hospitalization for heart failure at 30 days')).toMatchObject(UNKNOWN)
  })

  it('negative: a different population does not match', () => {
    expect(identify('death from any cause in patients with diabetes', 'death from any cause in patients without diabetes')).toMatchObject(UNKNOWN)
    expect(identify('death from any cause in patients with diabetes', 'death from any cause')).toMatchObject(UNKNOWN)
    expect(identify('death from any cause', 'death from any cause in patients with diabetes')).toMatchObject(UNKNOWN)
    expect(identify('new myocardial infarction in women', 'new myocardial infarction in men')).toMatchObject(UNKNOWN)
  })

  it('negative: a different treatment arm does not match', () => {
    expect(identify('death from any cause in the PCI group', 'death from any cause in the medical therapy group')).toMatchObject(UNKNOWN)
    expect(identify('death from any cause in the PCI group', 'death from any cause')).toMatchObject(UNKNOWN)
    expect(identify('death from any cause', 'death from any cause in the PCI group')).toMatchObject(UNKNOWN)
    expect(identify('hospitalization for heart failure in the device arm', 'hospitalization for heart failure in the control arm')).toMatchObject(UNKNOWN)
  })

  it('an unparsed secondary declaration does not veto an identical primary, and a secondary row does not replace it', () => {
    const source = 'The primary composite outcome was death from any cause or hospitalization for heart failure. Major secondary outcomes were left ventricular ejection fraction at 6 and 12 months and quality-of-life scores.'
    const secondary = row('Secondary outcome: left ventricular ejection fraction at 6 months')
    const primary = row('Primary composite outcome (death from any cause or hospitalization for heart failure), PCI vs optimal medical therapy, hazard ratio')
    const found = findPrimary([secondary, primary], () => true, source)
    expect(found).toMatchObject({ state: 'identified', basis: 'source', indexes: [1] })
    expect(findPrimary([secondary], () => true, source)).toMatchObject(UNKNOWN)
    expect(findPrimary([row('hospitalization for heart failure')], () => true, source)).toMatchObject(UNKNOWN)
  })

  it('strips a statistic label and the arm comparison even when the label sits before versus', () => {
    expect(identify(
      'death from any cause',
      'death from any cause, hazard ratio, beta-blocker vs placebo',
    )).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
    expect(identify('acute coronary syndrome', 'ACS')).toMatchObject({ state: 'identified', basis: 'source' })
    expect(identify('cardiovascular death', 'CV death')).toMatchObject({ state: 'identified', basis: 'source' })
    expect(identify('myocardial infarction', 'MI')).toMatchObject({ state: 'identified', basis: 'source' })
    expect(identify('heart failure hospitalization', 'HF hospitalization')).toMatchObject({ state: 'identified', basis: 'source' })
  })

  it('expands MACE only when this source defines it', () => {
    const defined = 'MACE (cardiovascular death, myocardial infarction, or stroke) was prespecified. The primary end point was cardiovascular death, myocardial infarction, or stroke.'
    expect(findPrimary([row('MACE')], () => true, defined)).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
    expect(findPrimary(
      [row('MACE')],
      () => true,
      'The primary end point was cardiovascular death, myocardial infarction, or stroke.',
    )).toMatchObject(UNKNOWN)
  })

  it('drops a parenthetical definition from the declared phrase and keeps a clinical parenthesis', () => {
    expect(findPrimary(
      [row('myocardial infarction')],
      () => true,
      'The primary end point was myocardial infarction (defined as a rise and fall of troponin).',
    )).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
    expect(findPrimary(
      [row('myocardial infarction')],
      () => true,
      'The primary end point was myocardial infarction (MI).',
    )).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
    expect(findPrimary(
      [row('death')],
      () => true,
      'The primary end point was death (cardiovascular only).',
    )).toMatchObject(UNKNOWN)
  })
})

function evidenceRow(name, quote) {
  return {
    quantity: { ...hr(name, quote) },
    verdict: { flagged: false },
  }
}

describe('a verified quote can identify the declared primary without name equality', () => {
  const passes = (row) => !row.verdict.flagged

  it('matches a generic primary-composite name only through the results sentence', () => {
    const source = 'The primary end point was death from any cause or hospitalization for heart failure. Death from any cause or hospitalization for heart failure occurred in 20% of patients.'
    const quote = 'Death from any cause or hospitalization for heart failure occurred in 20% of patients.'
    expect(findPrimary([row('Primary efficacy composite outcome')], () => true, source)).toMatchObject(UNKNOWN)
    expect(findPrimary([evidenceRow('Primary efficacy composite outcome', quote)], passes, source)).toMatchObject({
      state: 'identified', basis: 'evidence', verified: true, indexes: [0], reason: null,
    })
  })

  it('treats one unlabelled verified quote that reports the declared outcome as the primary', () => {
    const source = 'The primary end point was death from any cause. Death from any cause occurred in 11% of patients.'
    const quote = 'Death from any cause occurred in 11% of patients.'
    expect(findPrimary([evidenceRow('Between-group comparison', quote)], passes, source)).toMatchObject({
      state: 'identified', basis: 'evidence', verified: true, indexes: [0],
    })
  })

  it('keeps two quotes in the same results sentence and rejects two different results sentences', () => {
    const shared = 'The primary end point was death from any cause. Death from any cause occurred in 10% of the device group and 12% of the control group.'
    const together = findPrimary([
      evidenceRow('Primary efficacy composite outcome', 'Death from any cause occurred in 10% of the device group'),
      evidenceRow('Between-group comparison', '12% of the control group'),
    ], passes, shared)
    expect(together).toMatchObject({ state: 'identified', basis: 'evidence', indexes: [0, 1] })

    const split = 'The primary end point was death from any cause. Death from any cause occurred in 10% of the device group. Death from any cause occurred in 12% of the control group.'
    const apart = findPrimary([
      evidenceRow('Primary efficacy composite outcome', 'Death from any cause occurred in 10% of the device group.'),
      evidenceRow('Between-group comparison', 'Death from any cause occurred in 12% of the control group.'),
    ], passes, split)
    expect(apart).toMatchObject({ state: 'unknown', reason: PRIMARY_AMBIGUOUS_REASON, indexes: [] })
  })

  it('negative: a wrong component, a wrong timepoint, or a secondary quote does not bind', () => {
    const component = 'The primary end point was death from any cause or stroke. Stroke occurred in 5% of patients.'
    expect(findPrimary([
      evidenceRow('Primary efficacy composite outcome', 'Stroke occurred in 5% of patients.'),
    ], passes, component)).toMatchObject({ state: 'unknown', reason: PRIMARY_UNBOUND_REASON })

    const year = 'The primary end point was death from any cause within 30 days. Death from any cause at 1 year occurred in 10% of patients.'
    expect(findPrimary([
      evidenceRow('Primary efficacy composite outcome', 'Death from any cause at 1 year occurred in 10% of patients.'),
    ], passes, year)).toMatchObject({ state: 'unknown', reason: PRIMARY_UNBOUND_REASON })

    const relation = 'The primary end point was death from any cause within 30 days. Death from any cause at 30 days occurred in 4% of patients.'
    expect(findPrimary([
      evidenceRow('Primary efficacy composite outcome', 'Death from any cause at 30 days occurred in 4% of patients.'),
    ], passes, relation)).toMatchObject({ state: 'unknown', reason: PRIMARY_UNBOUND_REASON })

    const secondary = 'The primary end point was death from any cause. The secondary outcome was death from any cause, which occurred in 8% of patients.'
    expect(findPrimary([
      evidenceRow('Primary efficacy composite outcome', 'The secondary outcome was death from any cause, which occurred in 8% of patients.'),
    ], passes, secondary)).toMatchObject({ state: 'unknown', reason: PRIMARY_UNBOUND_REASON })
    expect(findPrimary([
      evidenceRow('Secondary outcome: death from any cause', 'Death from any cause occurred in 11% of patients.'),
    ], passes, 'The primary end point was death from any cause. Death from any cause occurred in 11% of patients.')).toMatchObject({
      state: 'unknown', reason: PRIMARY_UNBOUND_REASON,
    })
  })
})

describe('primary-outcome sentences the declaration reader can now see', () => {
  it('reads outcome measure, an appositive, a changed measure, and a main outcome line', () => {
    expect(findPrimary([row('death from any cause')], () => true, 'The primary outcome measure was death from any cause.')).toMatchObject({
      state: 'identified', basis: 'source', indexes: [0],
    })
    expect(findPrimary([row('death from any cause')], () => true, 'The primary outcome measure is death from any cause.')).toMatchObject({
      state: 'identified', basis: 'source', indexes: [0],
    })
    expect(findPrimary(
      [row('death from any cause')],
      () => true,
      'Death from any cause, the primary outcome, was higher in the device group.',
    )).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
    expect(findPrimary(
      [row('death from any cause')],
      () => true,
      'In March 1993, the primary outcome measures were changed to death from any cause.',
    )).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
    expect(findPrimary(
      [row('death from any cause')],
      () => true,
      'MAIN OUTCOME MEASURES: death from any cause. Costs were a secondary concern.',
    )).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
  })

  it('treats primary objectives with no stated outcome as unspecified, even if a row is labelled primary', () => {
    const source = 'The stated primary objectives were to compare procedural risks and long-term prevention of stroke.'
    expect(findPrimary([row('Primary outcome: procedural death or stroke')], () => true, source)).toMatchObject({
      state: 'unspecified', basis: 'no-declared-primary', name: null, reason: null,
    })
  })

  it('says the outcome sentence was unreadable when a primary is mentioned but not stated', () => {
    expect(findPrimary(
      [row('Primary outcome: death from any cause')],
      () => true,
      'The primary end point will be reported separately once follow-up is complete.',
    )).toMatchObject({ state: 'unknown', reason: PRIMARY_UNRECOGNIZED_REASON, indexes: [] })
  })

  it('does not declare a MAIN OUTCOME MEASURES list that names no single primary', () => {
    const source = 'MAIN OUTCOME MEASURES: All-cause mortality, myocardial infarction, stroke, and major bleeding.'
    expect(findPrimary([
      row('All-cause mortality, myocardial infarction, stroke, and major bleeding'),
      row('Death'),
    ], (entry) => !entry.verdict.flagged, source)).toMatchObject({
      state: 'unspecified', basis: 'no-declared-primary', name: null, verified: false, reason: null,
    })
  })

  it('still reads a MAIN line that states one composite', () => {
    expect(findPrimary(
      [row('death, myocardial infarction, or stroke')],
      () => true,
      'MAIN OUTCOME MEASURES: a composite of death, myocardial infarction, or stroke.',
    )).toMatchObject({ state: 'identified', basis: 'source', indexes: [0] })
  })
})

describe('subgroup arms and composite components are not the declared primary', () => {
  const passes = (entry) => !entry.verdict.flagged
  const padSource = [
    'Patients were randomly assigned to rivaroxaban or aspirin.',
    'The primary end point was cardiovascular death, myocardial infarction, or stroke.',
    'The primary end point occurred in 4.1% of the rivaroxaban group and 5.4% of the aspirin group.',
    'The absolute risk reduction for the primary end point was 3.5% in patients with PAD and 1.6% in patients with no PAD.',
  ].join(' ')

  it('does not identify PAD vs no PAD because the quote mentions the primary end point', () => {
    const treatment = {
      quantity: {
        ...hr(
          'cardiovascular death, myocardial infarction, or stroke, rivaroxaban vs aspirin',
          'The primary end point occurred in 4.1% of the rivaroxaban group and 5.4% of the aspirin group.',
        ),
      },
      verdict: { flagged: true },
    }
    const subgroup = evidenceRow(
      'absolute risk reduction for primary end point, PAD vs no PAD, 3.5% vs 1.6%',
      'The absolute risk reduction for the primary end point was 3.5% in patients with PAD and 1.6% in patients with no PAD.',
    )
    const primary = findPrimary([treatment, subgroup], passes, padSource)
    expect(primary).toMatchObject({ state: 'identified', verified: false, indexes: [0], reason: null })
    expect(findPrimary([subgroup], passes, padSource)).toMatchObject({
      state: 'unknown', verified: false, indexes: [], reason: PRIMARY_UNBOUND_REASON,
    })
  })

  it('rejects with versus without, with/without, and a comparison that is not the randomized arms', () => {
    const quote = 'The absolute risk reduction for the primary end point was 3.5% in patients with PAD and 1.6% in patients with no PAD.'
    for (const name of [
      'absolute risk reduction for primary end point, with PAD vs without PAD',
      'absolute risk reduction for primary end point, with/without PAD',
      'cardiovascular death, myocardial infarction, or stroke, bypass surgery vs stenting',
    ]) {
      expect(findPrimary([evidenceRow(name, quote)], passes, padSource), name).toMatchObject({
        state: 'unknown', verified: false, indexes: [],
      })
    }
  })

  it('does not let a verified component of the composite set primary.verified', () => {
    const source = [
      'Patients were randomly assigned to treatment or placebo.',
      'The primary end point was a composite of death, stroke, or cardiovascular hospitalization.',
      'The primary end point occurred in 12% of the treatment group and 15% of the placebo group (hazard ratio, 0.76; 95% CI, 0.65 to 0.89).',
    ].join(' ')
    const composite = {
      quantity: {
        ...hr(
          'Primary end point',
          'The primary end point occurred in 12% of the treatment group and 15% of the placebo group',
        ),
      },
      verdict: { flagged: true },
    }
    const components = [
      'Death, hazard ratio',
      'Stroke, hazard ratio',
      'Cardiovascular hospitalization, hazard ratio',
      'HF hospitalization, hazard ratio',
    ].map((name) => evidenceRow(name, 'hazard ratio, 0.76'))
    expect(findPrimary([composite, ...components], passes, source)).toMatchObject({
      state: 'identified', verified: false, indexes: [0], reason: null,
    })
    expect(findPrimary(components, passes, source)).toMatchObject({
      state: 'unknown', verified: false, indexes: [], reason: PRIMARY_UNBOUND_REASON,
    })
  })

  it('keeps the declared 4-year rate and drops the periprocedural rate of the same end point', () => {
    const source = [
      'Patients were randomly assigned to stenting or endarterectomy.',
      'The primary end point was a composite of any stroke, myocardial infarction, or death during the periprocedural period or ipsilateral stroke within 4 years after randomization.',
      'The estimated 4-year rate of the primary end point was 5.5%.',
      'The periprocedural primary end point occurred in 2.3% of patients.',
    ].join(' ')
    const fourYear = {
      quantity: {
        ...hr(
          'Estimated 4-year rate of primary end point',
          'The estimated 4-year rate of the primary end point was 5.5%.',
        ),
      },
      verdict: { flagged: true },
    }
    const periprocedural = evidenceRow(
      'Periprocedural rate of the primary end point',
      'The periprocedural primary end point occurred in 2.3% of patients.',
    )
    expect(findPrimary([fourYear, periprocedural], passes, source)).toMatchObject({
      state: 'identified', verified: false, indexes: [0], reason: null,
    })
    expect(findPrimary([periprocedural], passes, source)).toMatchObject({
      state: 'unknown', verified: false, indexes: [], reason: PRIMARY_UNBOUND_REASON,
    })
  })

  it('keeps beta-blocker vs no beta-blocker when that absence is the randomized arm', () => {
    const results = 'A primary end-point event occurred in 7.9% of the beta-blocker group and in 8.3% of the no beta-blocker group (hazard ratio, 0.96; 95% confidence interval, 0.79 to 1.16; P=0.64).'
    const declared = 'The primary end point was a composite of death from any cause or new myocardial infarction.'
    const quote = 'hazard ratio, 0.96; 95% confidence interval, 0.79 to 1.16'
    const rowName = 'beta-blocker vs no beta-blocker'
    for (const assignment of [
      'In this randomized trial, we randomly assigned patients to receive either a beta-blocker or no beta-blocker treatment.',
      'Patients were randomly assigned to a beta-blocker or no treatment.',
      'Patients were randomly assigned to a beta-blocker or usual care without a beta-blocker.',
    ]) {
      const source = `${assignment} ${declared} ${results}`
      expect(findPrimary([evidenceRow(rowName, quote)], passes, source), assignment).toMatchObject({
        state: 'identified', verified: true, indexes: [0], reason: null,
      })
    }
    const otherArms = 'Patients were randomly assigned to rivaroxaban or aspirin. The primary end point was a composite of death from any cause or new myocardial infarction. A primary end-point event occurred in 7.9% of the beta-blocker group and in 8.3% of the no beta-blocker group (hazard ratio, 0.96; 95% confidence interval, 0.79 to 1.16; P=0.64).'
    expect(findPrimary([evidenceRow(rowName, quote)], passes, otherArms)).toMatchObject({
      state: 'unknown', verified: false, indexes: [],
    })
  })

  it('keeps a composite named at the defined-term level and drops a single component', () => {
    const dapa = [
      'Patients were randomly assigned to dapagliflozin or placebo.',
      'The primary outcome was a composite of worsening heart failure (hospitalization or an urgent visit resulting in intravenous therapy for heart failure) or death from cardiovascular causes.',
      'The primary outcome occurred in 16.3% of the dapagliflozin group and in 21.2% of the placebo group (hazard ratio, 0.74; 95% CI, 0.65 to 0.85; P<0.001).',
    ].join(' ')
    const deliver = [
      'Patients were randomly assigned to dapagliflozin or placebo.',
      'The primary end point was a composite of worsening heart failure (which was defined as either an unplanned hospitalization for heart failure or an urgent visit for heart failure) or cardiovascular death.',
      'The primary end point occurred in 16.4% of the dapagliflozin group and in 19.5% of the placebo group (hazard ratio, 0.82; 95% CI, 0.73 to 0.92; P<0.001).',
    ].join(' ')
    const cases = [
      [dapa, 'hazard ratio, 0.74'],
      [deliver, 'hazard ratio, 0.82'],
    ]
    for (const [source, quote] of cases) {
      const composite = evidenceRow('worsening heart failure or cardiovascular death, hazard ratio', quote)
      const deathOnly = evidenceRow('cardiovascular death, hazard ratio', quote)
      const hospitalizationOnly = evidenceRow('hospitalization for heart failure, hazard ratio', quote)
      expect(findPrimary([composite, deathOnly, hospitalizationOnly], passes, source), quote).toMatchObject({
        state: 'identified', verified: true, indexes: [0], reason: null,
      })
      expect(findPrimary([deathOnly, hospitalizationOnly], passes, source), quote).toMatchObject({
        state: 'unknown', verified: false, indexes: [], reason: PRIMARY_UNBOUND_REASON,
      })
    }
  })
})
