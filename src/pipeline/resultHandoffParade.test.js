// Offline replay of the first real-paper handoff run (PARADE, PMID 42513277): the saved
// trace in __fixtures__/parade is the complete supplied source, the normalized extraction
// and the diagnostics recorded at checkpoint 7d0f5fe, where every record was rejected and
// the display withheld the summary. No model call: the checker is replaced by explicit
// verdict objects, so these tests prove what the deterministic gate admits and renders,
// not that the paper's conclusions are right.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildResultHandoff, prepareResultPlan, renderResult, applyResultApproval, restoreResultApproval, RELATIONSHIP_DIMENSIONS } from './resultHandoff.js'

const load = () => JSON.parse(readFileSync(new URL('./__fixtures__/parade/pmid42513277.json', import.meta.url), 'utf8'))
const byRow = (handoff, i) => handoff.records.find(r => r.rowIndex === i)
const accept = ids => ({ decisions: ids.map(id => ({ id, ...Object.fromEntries(RELATIONSHIP_DIMENSIONS.map(k => [k, 'supported'])) })), summary: { supported: true, included_ids: ids } })
const selectAll = handoff => prepareResultPlan(handoff, handoff.records.map(r => ({ id: r.id, includeEstimate: true })))

describe('PARADE trace: every supporting quote is real, and the checkpoint rejected every record', () => {
  it('fixture quotes are exact unique substrings of the supplied corpus', () => {
    const fx = load()
    for (const c of fx.resultContexts) {
      const spans = [...Object.values(c).filter(v => v && typeof v === 'object' && !Array.isArray(v)), ...c.qualifications]
      for (const s of spans) expect(fx.sourceDoc[s.corpus].split(s.quote).length - 1, s.quote).toBe(1)
    }
    expect(fx.recordedDiagnostics).toHaveLength(10)
  })
  it('admits the four comparative analyses that the checkpoint rejected for paraphrased labels', () => {
    const h = buildResultHandoff(load())
    expect(h.complete).toBe(true)
    expect(h.records.filter(r => r.kind === 'comparative').map(r => r.rowIndex)).toEqual([0, 1, 2, 3])
    // Conventional Cox, weighted patency, weighted survival (null) and competing-risk patency all survive.
    expect(byRow(h, 0).fields.analysis.text).toBe('multivariable Cox regression model')
    expect(byRow(h, 1).fields.analysis.text).toBe('inverse probability of treatment weighting')
    expect(byRow(h, 2).fields.effect.text).toBe('did not differ significantly')
    expect(byRow(h, 3).fields.analysis.text).toMatch(/Fine–Gray/)
  })
  it('keeps the bleeding caveat whose label dropped "were", and marks it a paraphrase', () => {
    const q = byRow(buildResultHandoff(load()), 0).qualifications
    expect(q.map(x => x.text)).toEqual(['residual confounding remains possible', 'bleeding complications not systematically captured'])
    expect(q.map(x => x.fidelity)).toEqual(['verbatim', 'paraphrase'])
  })
  it('accepts clinically typed contextual numbers in every field: 75 mm, 30-day', () => {
    const h = buildResultHandoff(load())
    // Record 7 now fails only its missing comparator, not the 75 mm descriptor.
    expect(h.diagnostics.find(d => d.quantityIndex === 7)).toEqual({ quantityIndex: 7, failures: [], missing: ['comparator'] })
    expect(byRow(h, 9).fields.endpointRole.text).toMatch(/30-day MACEs/)
    expect(byRow(h, 8).qualifications[0].text).toMatch(/30-day primary patency/)
  })
  it('withholds qualifications that add words or statistics, discloses them, and never renders them', () => {
    const h = buildResultHandoff(load())
    expect(byRow(h, 1).withheldQualifications).toEqual([{ field: 'qualification-0', reason: 'label-not-in-quote', text: 'log-rank p < 0.0001 versus robust log-rank p = 0.03' }])
    expect(byRow(h, 2).withheldQualifications[0].text).toMatch(/^conflicting/)
    expect(byRow(h, 3).withheldQualifications[0].text).toBe('residual confounding by indication possible')
    expect(h.diagnostics.filter(d => d.withheld).map(d => d.quantityIndex)).toEqual([1, 2, 3])
    const plan = selectAll(h)
    const take = applyResultApproval(h, plan, accept(plan.map(p => p.id)))
    expect(take.finding).not.toMatch(/0\.0001|0\.03|0\.20|conflicting|by indication/)
  })
  it('does not invent a comparator for a risk-factor estimate that names none', () => {
    const h = buildResultHandoff(load())
    expect(h.records.map(r => r.rowIndex)).not.toContain(7)
  })
  it('admits descriptive cohort outcomes without inventing a comparison, but renders them only with a verified tuple', () => {
    const h = buildResultHandoff(load())
    expect(h.records.filter(r => r.kind === 'descriptive').map(r => r.rowIndex)).toEqual([4, 5, 6, 8, 9])
    // None of these percentages has a provable tuple in this source, so none can render.
    expect(selectAll(h).map(p => p.id)).toEqual([0, 1, 2, 3].map(i => `42513277:result:${i}`))
    const r = byRow(h, 4)
    expect(renderResult({ ...r, numeric: true }, { id: r.id, includeEstimate: true })).toBe('overall survival. Analysis: Kaplan–Meier method. Endpoint role: The primary outcomes were primary patency and overall survival. Outcome timepoint: median follow-up of 30 months. Estimate: 90.3%.')
    expect(prepareResultPlan({ ...h, records: [{ ...r, numeric: true }] }, [{ id: r.id, includeEstimate: true }])).toEqual([{ id: r.id, includeEstimate: true }])
    expect(prepareResultPlan({ ...h, records: [{ ...r, numeric: true }] }, [{ id: r.id, includeEstimate: false }])).toEqual([])
  })
  it('renders a usable, non-empty summary that keeps the conflicting analyses and the design caveats', () => {
    const h = buildResultHandoff(load())
    const plan = selectAll(h)
    expect(plan.every(p => p.includeEstimate === false)).toBe(true) // no tuple verified under the current verifier
    const take = applyResultApproval(h, plan, accept(plan.map(p => p.id)))
    expect(take.check.verdict).toBe('supported')
    expect(take.finding).toContain('overall survival: combined therapy (CT) versus other postoperative antithrombotic regimens; worse overall survival. Analysis: multivariable Cox regression model.')
    expect(take.finding).toContain('overall survival: CT versus non-CT; did not differ significantly. Analysis: weighted analysis.')
    expect(take.finding).toContain('Outcome timepoint: median follow-up of 30 months.')
    expect(take.finding).toContain('bleeding complications not systematically captured.')
    expect(take.finding).not.toMatch(/\d\.\d\d? hazard ratio/)
    expect(restoreResultApproval(load(), take).finding).toBe(take.finding)
  })
  it('renders the estimate once the tuple verifies, bound to its own quote', () => {
    const h = buildResultHandoff(load())
    const r = byRow(h, 0)
    const forced = { ...h, records: h.records.map(x => x === r ? { ...x, numeric: true } : x) }
    const plan = prepareResultPlan(forced, [{ id: r.id, includeEstimate: true }])
    const take = applyResultApproval(forced, plan, accept([r.id]))
    expect(take.finding).toContain('Estimate: 1.30 hazard ratio (CI 1.04–1.61).')
    expect(take.findingBindings[0].quote).toBe(r.quantity.source_quote)
  })
})

describe('PARADE trace: adversarial labels on real source', () => {
  const mutate = alter => { const fx = load(); alter(fx); return buildResultHandoff(fx) }
  it('rejects an outcome swapped to a phrase printed elsewhere in the paper but not in its quote', () => {
    const h = mutate(fx => { fx.resultContexts[0].outcome.text = 'primary patency' })
    expect(h.records.map(r => r.rowIndex)).not.toContain(0)
    expect(h.diagnostics[0]).toEqual({ quantityIndex: 0, failures: [{ field: 'outcome', reason: 'label-not-in-quote' }], missing: [] })
  })
  it('rejects an effect that inserts a negation the quote does not print', () => {
    const h = mutate(fx => { fx.resultContexts[0].effect.text = 'not worse overall survival' })
    expect(h.diagnostics[0].failures).toEqual([{ field: 'effect', reason: 'label-not-in-quote' }])
  })
  it('rejects an effect that drops the negation its quote prints', () => {
    const h = mutate(fx => { fx.resultContexts[2].effect.text = 'differ significantly' })
    expect(h.diagnostics.find(d => d.quantityIndex === 2).failures).toEqual([{ field: 'effect', reason: 'label-drops-negation' }])
  })
  it('withholds a caveat that drops its negation rather than rendering the reversed claim', () => {
    const h = mutate(fx => { fx.resultContexts[0].qualifications[1].text = 'bleeding complications systematically captured' })
    expect(byRow(h, 0).qualifications.map(q => q.text)).toEqual(['residual confounding remains possible'])
    expect(byRow(h, 0).withheldQualifications[0]).toMatchObject({ reason: 'label-drops-negation' })
  })
  it('rejects a comparator reordered into a claim the quote does not make', () => {
    const h = mutate(fx => { fx.resultContexts[1].comparator.text = 'CT patients' ; fx.resultContexts[1].intervention.text = 'non-CT' })
    // Both labels are made of quote words, so the gate admits them; ordered comparison is the checker's dimension.
    expect(byRow(h, 1)).toBeTruthy()
    const plan = prepareResultPlan(h, [{ id: '42513277:result:1', includeEstimate: false }])
    const response = accept(plan.map(p => p.id)); response.decisions[0].orderedComparison = 'refuted'
    expect(applyResultApproval(h, plan, response).finding).toBe('')
  })
  it('rejects a timing descriptor whose number its quote does not print', () => {
    const h = mutate(fx => { fx.resultContexts[9].endpointRole.text = 'incidence of 90-day MACEs' })
    expect(h.diagnostics.find(d => d.quantityIndex === 9).failures).toEqual([{ field: 'endpointRole', reason: 'label-not-in-quote' }])
  })
  it.each(['HR of 1.30', '95% CI of 1.04–1.61', 'C = 0.523'])('rejects a statistic printed in the quote when it is smuggled into a label: %s', text => {
    const h = mutate(fx => { fx.resultContexts[0].analysis = { text, quote: fx.rows[0].quantity.source_quote, corpus: 'text' } })
    expect(h.diagnostics[0].failures).toEqual([{ field: 'analysis', reason: 'unsupported-context-number' }])
  })
  it('still rejects a fabricated quote and an ambiguous passage as before', () => {
    expect(mutate(fx => { fx.resultContexts[0].outcome.quote = 'This sentence is not in the paper.' }).diagnostics[0].failures).toEqual([{ field: 'outcome', reason: 'context-not-located' }])
    expect(mutate(fx => { fx.resultContexts[0].outcome.quote = 'overall survival' }).diagnostics[0].failures).toEqual([{ field: 'outcome', reason: 'ambiguous-context-passage' }])
  })
  it('rejects a borrowed confidence interval through the numeric receipt, not the label gate', () => {
    const fx = load(); fx.rows[0].quantity.ci_low = 1.06; fx.rows[0].quantity.ci_high = 1.56
    const h = buildResultHandoff(fx)
    expect(byRow(h, 0).numeric).toBe(false)
    expect(prepareResultPlan(h, [{ id: '42513277:result:0', includeEstimate: true }])[0].includeEstimate).toBe(false)
  })
  it('rejects every record when a cache hit replays wire-shaped (array) contexts instead of normalized ones', () => {
    // Release blocker outside this repair: pipeline.js consumes cached.extraction without
    // normalizeResultContexts, and a proxy-written cache may hold raw wire arrays.
    const fx = load()
    fx.resultContexts = fx.resultContexts.map(c => ({ ...c, ...Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'quantity_index' && k !== 'qualifications').map(([k, v]) => [k, v == null ? [] : [v]])) }))
    const h = buildResultHandoff(fx)
    expect(h.records).toEqual([])
    expect(h.diagnostics.every(d => d.failures?.some(f => f.reason === 'malformed-context-field'))).toBe(true)
  })
})
