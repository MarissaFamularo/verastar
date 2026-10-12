// Offline regression tests for the prose gate: invalid numeric fallback is withheld,
// a clean fallback is retained, and a late primary-endpoint definition in a long Methods
// block survives the window allocation. Synthetic fixtures only.
import { describe, it, expect } from 'vitest'
import { sanitizeRanking } from './triage.js'
import { selectEvidenceWindow, EVIDENCE_WINDOW_VERSION, compactMethods } from './evidenceWindow.js'
import { SNIPPET_CHARS } from './check.js'

const base = { id: 'p1', score: 70, tier: 1, design_caution: '', relevance: 'Relevant.' }
const V = [{ name: 'hazard ratio', value: '0.84 (CI 0.61–1.16)', quote: 'hazard ratio 0.84 (95% CI 0.61-1.16)' }]

describe('invalid numeric fallback is withheld, not stripped', () => {
  it('finding with an unbacked timepoint and a digit-bearing finding_plain -> empty finding', () => {
    const out = sanitizeRanking({
      ...base,
      finding: 'Reduced the 5-year rate of stroke and death (HR 0.84).',
      finding_plain: 'Reduced the 5-year rate of stroke and death.',
    }, V)
    expect(out.finding).toBe('')
    expect(out.finding).not.toMatch(/year rate/)
  })
  it('empty finding_plain -> empty finding', () => {
    const out = sanitizeRanking({ ...base, finding: 'Lower risk at 5 years.', finding_plain: '   ' }, V)
    expect(out.finding).toBe('')
  })
  it('clean number-free fallback is retained', () => {
    const out = sanitizeRanking({
      ...base,
      finding: 'Lower risk at 5 years (HR 0.84).',
      finding_plain: 'Lower risk of the reported primary composite endpoint.',
    }, V)
    expect(out.finding).toBe('Lower risk of the reported primary composite endpoint.')
  })
  it('nomenclature digits (letter-glued) count as number-free fallback', () => {
    const out = sanitizeRanking({
      ...base,
      finding: 'Improved by 99 mmHg.',
      finding_plain: 'Improved TcPO2 perfusion.',
    }, V)
    expect(out.finding).toBe('Improved TcPO2 perfusion.')
  })
  it('a grounded finding still renders unchanged', () => {
    const out = sanitizeRanking({ ...base, finding: 'HR 0.84 for the endpoint.', finding_plain: 'Lower hazard.' }, V)
    expect(out.finding).toBe('HR 0.84 for the endpoint.')
  })
})

describe('late primary endpoint definition survives the Methods allocation', () => {
  const FILLER = 'Adults with condition Z were enrolled across many centers under a protocol. '.repeat(14)
  const ENDPOINT = 'The primary outcome was a composite of event A and event B within the specified window.'
  const R1 = 'Primary result one: the composite did not differ between arms in the first comparison.'
  const R2 = 'Primary result two: the composite did not differ between arms in the second comparison.'
  const text = (methods) => ['Synthetic title.', `METHODS: ${methods}`, `RESULTS: ${R1}`, `RESULTS: ${R2}`, 'CONCLUSIONS: Similar outcomes.'].join('\n\n')

  it('long methods: the endpoint sentence is kept within budget and both Results remain', () => {
    const long = `${FILLER} ${ENDPOINT}`
    expect(long.length).toBeGreaterThan(600)
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: text(long) })
    expect(w.version).toBe(EVIDENCE_WINDOW_VERSION)
    expect(w.text).toContain(ENDPOINT)
    expect(w.text).toContain(R1)
    expect(w.text).toContain(R2)
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
    const methods = w.parts.find((p) => p.kind === 'methods')
    expect(methods.chars).toBeLessThanOrEqual(601)
    // design/population context still precedes the endpoint, in source order
    expect(w.text.indexOf('Adults with condition Z')).toBeLessThan(w.text.indexOf(ENDPOINT))
    expect(w.text.indexOf('METHODS')).toBeLessThan(w.text.indexOf('RESULTS'))
  })
  it('short methods are unchanged', () => {
    const short = `Adults were randomized. ${ENDPOINT}`
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: text(short) })
    expect(w.text).toContain(`METHODS: ${short}`)
  })
  it('long methods without an endpoint definition are plainly truncated as before', () => {
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: text(FILLER) })
    expect(w.text).not.toContain('The primary outcome')
    expect(w.text).toMatch(/…/)
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
  })
  it('no introduction fallback: full text with no Results and no abstract is unavailable', () => {
    const w = selectEvidenceWindow({ tier: 'full_text', sections: [{ label: 'Introduction', kind: 'background', text: ENDPOINT }], abstractParts: [] })
    expect(w).toMatchObject({ kind: 'unavailable', text: '' })
  })
})

describe('sentence boundaries preserve decimals in rescued definitions', () => {
  it('retains the entire endpoint sentence containing a decimal threshold', () => {
    const opening = 'Adults were randomized. '
    const filler = 'A long description of recruitment and assessment procedures. '.repeat(14)
    const endpoint = 'The primary outcome was event A above 0.5 units or event B within follow-up.'
    const text = compactMethods(opening + filler + endpoint, 400)
    expect(text).toContain(endpoint)
    expect(text).toContain('Adults were randomized.')
    expect(text.length).toBeLessThanOrEqual(400)
  })
})

describe('long unstructured body Results use labelled abstract findings', () => {
  const abstractParts = [
    {label:'Methods',text:'Adults were randomized between procedures.'},
    {label:'Findings',text:'There was no statistically clear difference in the primary composite outcome.'},
  ]
  it('does not fill the snippet with recruitment before the outcome paragraph', () => {
    const source = {tier:'full_text',abstractParts,sections:[{label:'Results',kind:'results',text:'Recruitment and procedure details. '.repeat(110) + 'The primary composite outcome did not differ.'}]}
    const w = selectEvidenceWindow(source)
    expect(w.kind).toBe('abstract')
    expect(w.text).toContain("[Evidence window: the paper's abstract]")
    expect(w.text).toContain(abstractParts[1].text)
    expect(w.text).not.toContain('Recruitment and procedure details')
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
  })
  it('keeps a short body Results section instead of switching needlessly', () => {
    const w = selectEvidenceWindow({tier:'full_text',abstractParts,sections:[{label:'Results',kind:'results',text:'The primary outcome was lower after treatment.'}]})
    expect(w.kind).toBe('results')
    expect(w.text).toContain('The primary outcome was lower after treatment.')
  })
})
