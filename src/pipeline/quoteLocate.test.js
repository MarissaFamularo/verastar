// quoteLocate.test.js — the shared quote locator on the FROZEN evidence records
// (docs/evidence/2026-10-17/verifier/final-170a26c/records). The final candidate rejected
// every balloon context and 50 of 53 NPT contexts because raw indexOf saw the saved
// line wrapping; under the verifier's normalization all of them locate, with positions in
// the original source.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeWithMap, locateQuote, locateSpan, locateAudit } from './quoteLocate.js'
import { normalize } from './verify.js'
import { buildResultHandoff } from './resultHandoff.js'

const RECORDS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'evidence', '2026-10-17', 'verifier', 'final-170a26c', 'records')
const frozen = (pmid) => JSON.parse(fs.readFileSync(path.join(RECORDS, `${pmid}.json`), 'utf8'))

describe('normalizeWithMap — the verifier normalization with source positions', () => {
  it.each([
    'Plain text with 0·84 and 1,234 and – dashes',
    'Line\nwrapped   text\twith  spaces',
    'Ｆｕｌｌwidth ＤＥＢ and ½ and 10² glued',
    'UPPER Case and “curly” quotes',
  ])('matches verify.normalize exactly for %j', (s) => {
    const out = normalizeWithMap(s)
    expect(out.text).toBe(normalize(s))
    expect(out.exact).toBe(true)
    expect(out.map.length).toBe(out.text.length)
  })
  it('maps every normalized character back to the original index it came from', () => {
    const src = 'A  B\n0·5 and 1,000'
    const { text, map } = normalizeWithMap(src)
    expect(text).toBe('a b 0.5 and 1000')
    expect(src[map[text.indexOf('0')]]).toBe('0')
    expect(src[map[text.indexOf('.')]]).toBe('·')
    expect(src.slice(map[text.indexOf('1000')], map[text.indexOf('1000') + 3] + 1)).toBe('1,000')
  })
})

describe('locateQuote', () => {
  const src = 'Primary patency was 67.3% vs. 50% at 12 months.\nThe difference was not significant (p = 0.16). Restenosis occurred in 10 patients. Restenosis occurred in 10 patients.'
  it('locates a verbatim quote with raw positions', () => {
    const r = locateQuote(src, 'Primary patency was 67.3% vs. 50% at 12 months.')
    expect(r).toMatchObject({ status: 'located', raw: true, whitespaceOnly: false, start: 0 })
    expect(src.slice(r.start, r.end)).toBe('Primary patency was 67.3% vs. 50% at 12 months.')
  })
  it('locates a quote that differs only in whitespace and reports it as such', () => {
    const r = locateQuote(src, 'at 12 months. The difference was not significant')
    expect(r).toMatchObject({ status: 'located', raw: false, whitespaceOnly: true })
    expect(src.slice(r.start, r.end)).toBe('at 12 months.\nThe difference was not significant')
  })
  it('locates under dash / interpunct / thousands normalization and says it was not whitespace alone', () => {
    const r = locateQuote('OR 1·45 (95% CI 0·91–2·29; 4,469 participants)', 'OR 1.45 (95% CI 0.91-2.29; 4469 participants)')
    expect(r).toMatchObject({ status: 'located', raw: false, whitespaceOnly: false })
  })
  it('reports a repeated quote as ambiguous without an anchor and resolves it to the nearest occurrence with one', () => {
    expect(locateQuote(src, 'Restenosis occurred in 10 patients.')).toMatchObject({ status: 'ambiguous' })
    const near = locateQuote(src, 'Restenosis occurred in 10 patients.', { near: normalize(src).length })
    expect(near).toMatchObject({ status: 'located', disambiguated: true })
    expect(near.start).toBeGreaterThan(src.indexOf('Restenosis'))
  })
  it('reports a quote the source does not contain as missing, never fuzzy', () => {
    expect(locateQuote(src, 'Primary patency was 68.3% vs. 50%')).toEqual({ status: 'missing' })
    expect(locateQuote(src, '')).toEqual({ status: 'empty' })
  })
  it('locateSpan refuses a malformed span and audits counts', () => {
    expect(locateSpan({ text: src }, { text: 'x' })).toEqual({ status: 'malformed' })
    expect(locateAudit([{ status: 'located', raw: true }, { status: 'located', whitespaceOnly: true }, { status: 'ambiguous' }, { status: 'missing' }])).toEqual({ spans: 4, located: 2, raw: 1, whitespaceOnly: 1, normalizedOnly: 0, ambiguous: 1, missing: 1 })
  })
})

describe('frozen records — whitespace-normalized quote recovery', () => {
  it('balloon (PMID 42573020): 39 of 39 context spans locate, all whitespace-only mismatches', () => {
    const h = buildResultHandoff(frozen('42573020').result)
    expect(h.audit).toEqual({ spans: 39, located: 39, raw: 0, whitespaceOnly: 39, normalizedOnly: 0, ambiguous: 0, missing: 0 })
    expect(h.records).toHaveLength(5)
    expect(h.records.every((r) => r.unlocated.length === 0)).toBe(true)
  })
  it('NPT (PMID 42681580): 53 of 53 context spans locate', () => {
    const h = buildResultHandoff(frozen('42681580').result)
    expect(h.audit).toMatchObject({ spans: 53, located: 53, ambiguous: 0, missing: 0 })
    expect(h.audit.whitespaceOnly).toBe(50)
  })
  it('a located span keeps the record even when another field of the same record is missing', () => {
    const d = frozen('42573020').result
    const contexts = structuredClone(d.resultContexts)
    contexts[0].outcome = { text: 'amputation', quote: 'This sentence is not in the source.', corpus: 'text' }
    const h = buildResultHandoff({ ...d, resultContexts: contexts })
    expect(h.records).toHaveLength(5)
    expect(h.records[0].fields.outcome.status).toBe('missing')
    expect(h.records[0].fields.endpointRole.status).toBe('located')
    expect(h.records[0].unlocated).toEqual([{ field: 'outcome', status: 'missing' }])
    expect(h.audit.missing).toBe(1)
  })
  it('a partial comparison stays a record with kind "partial"', () => {
    const h = buildResultHandoff(frozen('42681580').result)
    expect(h.records.map((r) => r.kind)).toContain('partial')
  })
})
