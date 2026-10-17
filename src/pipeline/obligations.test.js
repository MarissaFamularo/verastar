// obligations.test.js — coverage obligations and primary status come from LOCATED quotes
// only. Model text that does not locate is reported, never an obligation; a model label
// without a located declaration never establishes primary status.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildResultHandoff } from './resultHandoff.js'
import { buildObligations, conclusionSentence, abstractTextFor, primaryStatusFor, primaryFromLocatedQuotes, quoteNamesOutcome } from './obligations.js'

const RECORDS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'evidence', '2026-10-17', 'verifier', 'final-170a26c', 'records')
const frozen = (pmid) => JSON.parse(fs.readFileSync(path.join(RECORDS, `${pmid}.json`), 'utf8')).result

const SOURCE = 'Title.\n\nMETHODS: The primary outcome was major amputation at one year. Secondary outcomes were death and restenosis.\nRESULTS: Amputation did not differ (OR 1.45, 95% CI 0.91 to 2.29; P = 0.12; low-certainty evidence). Death did not differ (OR 0.97).\nCONCLUSION: Drug-coated balloons reduce restenosis but clinical benefit is unproven. More trials are needed.'
const span = (text, quote) => ({ text, quote, corpus: 'text' })
const quantity = (name, value, quote) => ({ name, quantity_type: 'single', value, range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, unit: 'odds ratio', ci_low: null, ci_high: null, p_value: null, source_quote: quote, location_hint: 'Results' })
const verdict = { flagged: true, relationshipValidated: false }
function result(contexts) {
  return {
    paper: { id: 'p1' }, source: { tier: 'abstract_only' }, sourceDoc: { text: SOURCE, tables: '' },
    rows: [
      { quantity: quantity('Amputation at one year, DEB vs POBA', 1.45, 'Amputation did not differ (OR 1.45, 95% CI 0.91 to 2.29; P = 0.12; low-certainty evidence).'), verdict },
      { quantity: quantity('Death, DEB vs POBA', 0.97, 'Death did not differ (OR 0.97).'), verdict },
    ],
    resultContexts: contexts,
  }
}
const base = (over = {}) => ({ quantity_index: 0, outcome: span('Amputation', 'Amputation did not differ (OR 1.45, 95% CI 0.91 to 2.29; P = 0.12; low-certainty evidence).'), intervention: null, comparator: null, analysis: null, interventionTiming: null, outcomeTimepoint: null, endpointRole: null, analysisRole: null, effect: null, qualifications: [], conflictingAnalyses: [], ...over })

describe('buildObligations', () => {
  it('builds obligations from located endpoint-role, qualification, conflicting-analysis, timing spans and the conclusion sentence', () => {
    const h = buildResultHandoff(result([base({
      endpointRole: span('primary outcome', 'The primary outcome was major amputation at one year.'),
      qualifications: [span('low-certainty evidence', 'low-certainty evidence')],
      conflictingAnalyses: [span('death did not differ', 'Death did not differ (OR 0.97).')],
      interventionTiming: span('at one year', 'The primary outcome was major amputation at one year.'),
    })]))
    const { obligations, unlocated } = buildObligations(h, { abstract: SOURCE })
    expect(unlocated).toEqual([])
    expect(obligations.map((o) => o.kind)).toEqual(['endpoint-role', 'qualification', 'conflicting-analysis', 'conclusion'])
    expect(obligations.find((o) => o.kind === 'conclusion').quote).toBe('Drug-coated balloons reduce restenosis but clinical benefit is unproven.')
    // Every obligation is a located quote with source positions and a stable id.
    for (const o of obligations) {
      expect(SOURCE.slice(o.start, o.end)).toBe(o.quote)
      expect(o.id).toMatch(/^ob\d+$/)
    }
  })
  it('excludes model text that does not locate and reports it', () => {
    const h = buildResultHandoff(result([base({
      endpointRole: span('primary outcome', 'The primary outcome was limb salvage at two years.'),
      qualifications: [span('underpowered', 'The trials were underpowered for amputation.')],
    })]))
    const { obligations, unlocated } = buildObligations(h, { abstract: '' })
    expect(obligations).toEqual([])
    expect(unlocated.map((u) => [u.kind, u.status])).toEqual([['endpoint-role', 'missing'], ['qualification', 'missing']])
  })
  it('deduplicates the same located passage across records and sorts by source position', () => {
    const role = span('primary outcome', 'The primary outcome was major amputation at one year.')
    const h = buildResultHandoff(result([base({ endpointRole: role }), base({ quantity_index: 1, endpointRole: role, outcome: span('Death', 'Death did not differ (OR 0.97).') })]))
    const { obligations } = buildObligations(h, { abstract: '' })
    expect(obligations.filter((o) => o.kind === 'endpoint-role')).toHaveLength(1)
  })
  it('takes the conclusion sentence from a labelled Conclusions part, else the last sentence', () => {
    expect(conclusionSentence(SOURCE)).toBe('Drug-coated balloons reduce restenosis but clinical benefit is unproven.')
    expect(conclusionSentence('An unstructured abstract. It ends here.')).toBe('It ends here.')
    expect(conclusionSentence('')).toBe('')
  })
  it('reads the abstract from the evidence source, the PUBLISHER ABSTRACT block, or the abstract-only corpus', () => {
    expect(abstractTextFor({ evidenceSource: { abstractParts: [{ label: 'Conclusions', text: 'A.' }] } })).toBe('Conclusions: A.')
    expect(abstractTextFor({ source: { tier: 'full_text' }, sourceDoc: { text: 'PUBLISHER ABSTRACT:\nResults: X.\n\nBody.' } })).toBe('Results: X.')
    expect(abstractTextFor({ source: { tier: 'abstract_only' }, sourceDoc: { text: 'Whole abstract.' } })).toBe('Whole abstract.')
    expect(abstractTextFor({ source: { tier: 'full_text' }, sourceDoc: { text: 'Body only.' } })).toBe('')
  })
})

describe('primary status from located quotes', () => {
  it('a located endpoint-role quote naming the row\'s outcome as primary establishes primary status', () => {
    const h = buildResultHandoff(result([base({ endpointRole: span('primary outcome', 'The primary outcome was major amputation at one year.') })]))
    expect(primaryStatusFor(h.records[0])).toMatchObject({ status: 'primary' })
    expect(primaryFromLocatedQuotes(h)).toMatchObject({ state: 'identified', indexes: [0], basis: 'located-endpoint-role', verified: false })
  })
  it('a model label without a located quote never establishes primary status', () => {
    const h = buildResultHandoff(result([base({ endpointRole: span('primary outcome', 'The primary outcome was amputation at one year.') })]))
    expect(h.records[0].fields.endpointRole.status).toBe('missing')
    expect(primaryStatusFor(h.records[0])).toMatchObject({ status: 'unknown' })
    expect(primaryFromLocatedQuotes(h)).toMatchObject({ state: 'unknown' })
    expect(primaryFromLocatedQuotes(h, { fallback: { state: 'unknown', name: null, verified: false, indexes: [], basis: null } })).toMatchObject({ state: 'unknown' })
  })
  it('a located declaration that names a different outcome, or both roles, leaves the row unknown', () => {
    const h = buildResultHandoff(result([base({ outcome: span('Death', 'Death did not differ (OR 0.97).'), endpointRole: span('primary outcome', 'The primary outcome was major amputation at one year.') })]))
    expect(primaryStatusFor(h.records[0])).toMatchObject({ status: 'unknown' })
    const both = buildResultHandoff(result([base({ endpointRole: span('primary', 'The primary outcome was major amputation at one year. Secondary outcomes were death and restenosis.') })]))
    expect(primaryStatusFor(both.records[0]).status).toBe('unknown')
  })
  it('a located declaration naming the outcome as secondary marks it secondary', () => {
    const h = buildResultHandoff(result([base({ quantity_index: 1, outcome: span('Death', 'Death did not differ (OR 0.97).'), endpointRole: span('secondary outcomes', 'Secondary outcomes were death and restenosis.') })]))
    expect(primaryStatusFor(h.records[0])).toMatchObject({ status: 'secondary' })
  })
  it('quoteNamesOutcome accepts the phrase or all of its content words', () => {
    expect(quoteNamesOutcome('The primary outcome was major amputation.', 'amputation')).toBe(true)
    expect(quoteNamesOutcome('The primary outcome was major amputation.', 'death')).toBe(false)
    expect(quoteNamesOutcome('Primary outcomes were primary patency and overall survival', 'overall survival')).toBe(true)
  })
  it('frozen aspirin record: MACE and bleeding are primary by located quote; NACE is not', () => {
    const h = buildResultHandoff(frozen('42769537'))
    const statuses = h.records.map((r) => primaryStatusFor(r).status)
    expect(statuses[0]).toBe('primary') // MACE, primary efficacy end point
    expect(statuses[1]).toBe('primary') // bleeding, primary safety end point
    expect(statuses[3]).not.toBe('primary') // NACE
    expect(primaryFromLocatedQuotes(h)).toMatchObject({ state: 'identified', indexes: [0, 1] })
  })
  it('frozen TADV record (single-arm): no located declaration, so the primary stays unknown', () => {
    expect(primaryFromLocatedQuotes(buildResultHandoff(frozen('42600759')))).toMatchObject({ state: 'unknown' })
  })
})
