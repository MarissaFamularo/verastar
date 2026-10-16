import { describe, it, expect } from 'vitest'
import { buildResultHandoff, prepareResultPlan, applyResultApproval, restoreResultApproval, renderResult, RELATIONSHIP_DIMENSIONS, MAX_HANDOFF_BYTES } from './resultHandoff.js'

const quote = 'In the intention-to-treat analysis, treatment A versus treatment B reduced bleeding (HR 0.44, 95% CI 0.34–0.55).'
const second = 'In the per-protocol analysis, treatment B versus treatment A reduced MACE (HR 1.05, 95% CI 0.83–1.32).'
const field = (text, source) => ({ text, quote: source, corpus: 'text' })
function fixture() {
  const source = `${quote} ${second}`
  const q = (source_quote, value, ci_low, ci_high) => ({ name: 'Untrusted name', quantity_type: 'single', source_quote, unit: 'hazard ratio', value, ci_low, ci_high })
  const context = (i, outcome, intervention, comparator, analysis) => ({ quantity_index: i,
    outcome: field(outcome, source), intervention: field(intervention, source), comparator: field(comparator, source), analysis: field(analysis, source),
    interventionTiming: null, outcomeTimepoint: null, endpointRole: null, analysisRole: null,
    effect: field(`reduced ${outcome}`, source), qualifications: [] })
  return { paper: { id: 'paper' }, sourceDoc: { text: source, tables: '' },
    rows: [{ quantity: q(quote, .44, .34, .55) }, { quantity: q(second, 1.05, .83, 1.32) }],
    resultContexts: [context(0, 'bleeding', 'treatment A', 'treatment B', 'intention-to-treat'), context(1, 'MACE', 'treatment B', 'treatment A', 'per-protocol')] }
}
const accept = ids => ({ decisions: ids.map(id => ({ id, ...Object.fromEntries(RELATIONSHIP_DIMENSIONS.map(k => [k, 'supported'])) })), summary: { supported: true, included_ids: ids } })
const setup = () => {
  const result = fixture(), handoff = buildResultHandoff(result)
  const plan = prepareResultPlan(handoff, handoff.records.map(r => ({ id: r.id, includeEstimate: true })))
  const response = accept(plan.map(p => p.id))
  return { result, handoff, plan, response }
}

describe('source-backed handoff and useful rendering', () => {
  it('keeps outcome, ordered comparison, analysis and verified tuple together without claiming primacy', () => {
    const { handoff, plan, response } = setup()
    const take = applyResultApproval(handoff, plan, response)
    expect(take.finding).toContain('bleeding: treatment A versus treatment B')
    expect(take.finding).toContain('Analysis: intention-to-treat')
    expect(take.finding).toContain('0.44 hazard ratio')
    expect(take.finding).toContain('0.34–0.55')
    expect(take.finding).not.toMatch(/secondary|primary/)
  })
  it('retains a qualitative result when its numeric receipt is not verified', () => {
    const result = fixture(); result.rows[0].quantity.value = .45
    const handoff = buildResultHandoff(result)
    const plan = prepareResultPlan(handoff, [{ id: handoff.records[0].id, includeEstimate: true }])
    expect(plan[0].includeEstimate).toBe(false)
    const take = applyResultApproval(handoff, plan, accept([plan[0].id]))
    expect(take.finding).toContain('reduced bleeding')
    expect(take.finding).not.toContain('Estimate:')
  })
  it('keeps a valid result when another is refuted and the retained summary is approved', () => {
    const { handoff, plan, response } = setup()
    response.decisions[0].analysis = 'refuted'
    response.summary.included_ids = [plan[1].id]
    const take = applyResultApproval(handoff, plan, response)
    expect(take.finding).toContain('MACE:')
    expect(take.finding).not.toContain('bleeding:')
  })
  it('withholds an individually approved selection when the whole summary omits conflicting analyses', () => {
    const { handoff, plan, response } = setup(); response.summary.supported = false
    expect(applyResultApproval(handoff, plan, response).finding).toBe('')
  })
  it.each(['unknown', 'refuted', undefined])('does not render a selected claim with %s relationship approval', status => {
    const { handoff, plan, response } = setup(); response.decisions[0].orderedComparison = status
    expect(applyResultApproval(handoff, plan, response).finding).toBe('')
  })
  it('rejects absent, duplicate, foreign and missing verdicts', () => {
    for (const alter of [r => { r.decisions = [] }, r => r.decisions.push(r.decisions[0]), r => { r.summary.included_ids = ['foreign'] }, r => { delete r.summary }]) {
      const { handoff, plan, response } = setup(); alter(response)
      expect(applyResultApproval(handoff, plan, response).finding).toBe('')
    }
  })
  it('does not truncate an over-budget source', () => {
    const result = fixture(); result.sourceDoc.text += 'x'.repeat(MAX_HANDOFF_BYTES)
    const handoff = buildResultHandoff(result)
    expect(handoff.complete).toBe(false)
    expect(handoff.source.text.length).toBeGreaterThan(MAX_HANDOFF_BYTES)
    expect(prepareResultPlan(handoff, [{ id: 'paper:result:0', includeEstimate: true }])).toEqual([])
  })
  it('rejects fabricated or ambiguous source spans and duplicate quantity proposals without harming another result', () => {
    for (const alter of [r => { r.resultContexts[0].outcome.quote = 'fabrication' }, r => { r.resultContexts[0].outcome.text = 'mortality' }, r => r.resultContexts.push(r.resultContexts[0])]) {
      const result = fixture(); alter(result)
      expect(buildResultHandoff(result).records.map(r => r.rowIndex)).toEqual([1])
    }
  })
  it('uses raw-source offsets rather than normalized offsets', () => {
    const result = fixture(); result.sourceDoc.text = `A paragraph with ﬁ ligature. ${result.sourceDoc.text}`
    const handoff = buildResultHandoff(result)
    const span = handoff.records[0].fields.outcome
    expect(handoff.source.text.slice(span.start, span.end)).toBe(span.quote)
  })
})

describe('immutable approval binding — original four mutation requirements', () => {
  it('restores unchanged approved output', () => {
    const { result, handoff, plan, response } = setup(); const take = applyResultApproval(handoff, plan, response)
    expect(restoreResultApproval(result, take).finding).toBe(take.finding)
  })
  it.each([
    ['outcome swap', r => { r.resultContexts[0].outcome.text = 'MACE' }],
    ['comparator reversal', r => { const c = r.resultContexts[0]; [c.intervention, c.comparator] = [c.comparator, c.intervention] }],
    ['analysis substitution', r => { r.resultContexts[0].analysis.text = 'per-protocol' }],
    ['borrowed CI', r => { r.rows[0].quantity.ci_low = .83; r.rows[0].quantity.ci_high = 1.32 }],
    ['source change', r => { r.sourceDoc.text += ' Changed evidence.' }],
    ['qualification change', r => { r.resultContexts[0].qualifications.push(field('per-protocol', r.sourceDoc.text)) }],
  ])('invalidates %s after approval', (_name, mutate) => {
    const { result, handoff, plan, response } = setup(); const take = applyResultApproval(handoff, plan, response)
    mutate(result)
    expect(restoreResultApproval(result, take).finding).toBe('')
  })
  it('invalidates changed selection plan and rendered wording', () => {
    const { result, handoff, plan, response } = setup()
    const take = applyResultApproval(handoff, plan, response)
    take.resultApproval.plan.reverse()
    expect(restoreResultApproval(result, take).finding).toBe('')
    const other = applyResultApproval(handoff, plan, response); other.finding = other.finding.replace('bleeding', 'MACE')
    expect(restoreResultApproval(result, other).finding).toBe('')
  })
  it('renders only the plan, never free model estimate text', () => {
    const { handoff, plan } = setup()
    expect(renderResult(handoff.records[0], { ...plan[0], estimate: 'HR 9.99' })).not.toContain('9.99')
  })
})

it('provides exact tuple spans for links instead of numeric-overlap inference', () => {
  const { handoff, plan, response } = setup()
  const take = applyResultApproval(handoff, plan, response)
  expect(take.findingBindings).toHaveLength(2)
  for (const binding of take.findingBindings) expect(take.finding.slice(binding.start, binding.end)).toBe(binding.text)
  expect(take.findingBindings[0].quote).toBe(quote)
  expect(take.findingBindings[1].quote).toBe(second)
})

it('revalidates saved-paper approvals without mutating original library data', async () => {
  const { currentResultPaper } = await import('./resultHandoff.js')
  const { result, handoff, plan, response } = setup()
  const take = applyResultApproval(handoff, plan, response)
  const paper = { ...take, id: result.paper.id, fullText: result.sourceDoc.text, tables: '', resultContexts: result.resultContexts,
    quantities: result.rows.map(r => ({ ...r.quantity, verdict: {}, tier: 'old' })) }
  const original = JSON.stringify(paper)
  expect(currentResultPaper(paper).finding).toBe(take.finding)
  expect(JSON.stringify(paper)).toBe(original)
  expect(currentResultPaper({ ...paper, fullText: paper.fullText + ' New evidence.' }).finding).toBe('')
})

// Needs the branch's lib/claimCheck.js and lib/digestStore.js wiring, which the review packet did not include.
it.skip('links identical estimates to their own approved receipt, never the first numeric match', async () => {
  const { linkFindingNumbers } = await import('../lib/claimCheck.js')
  const { handoff, plan, response } = setup()
  const take = applyResultApproval(handoff, plan, response)
  const intended = { quantity: handoff.records[0].quantity }
  const decoy = { quantity: { ...intended.quantity, source_quote: quote.replace('bleeding', 'mortality') } }
  const linked = linkFindingNumbers(take.finding, [decoy, intended], take.findingBindings).filter(s => s.row)
  expect(linked).toHaveLength(1)
  expect(linked[0].row).toBe(intended)
})

it('binds exact caution text and preserves an unrelated valid finding after caution mutation', () => {
  const { result, handoff, plan, response } = setup(); response.caution_supported = true
  const take = applyResultApproval(handoff, plan, response, 'The analysis has limitations.')
  expect(restoreResultApproval(result, take).cautionCheck.verdict).toBe('supported')
  const changed = restoreResultApproval(result, { ...take, designCaution: 'This was a randomized trial.' })
  expect(changed.finding).toBe(take.finding)
  expect(changed.designCaution).toBe('')
  expect(changed.cautionCheck.verdict).toBe('refuted')
})
it('clears finding and caution on stale source and changed approved caution input', () => {
  const { result, handoff, plan, response } = setup(); response.caution_supported = true
  const take = applyResultApproval(handoff, plan, response, 'The analysis has limitations.')
  const changed = structuredClone(result); changed.sourceDoc.text += ' Changed.'
  const stale = restoreResultApproval(changed, take)
  expect(stale.finding).toBe(''); expect(stale.designCaution).toBe(''); expect(stale.cautionCheck.verdict).toBe('refuted')
  take.resultApproval.cautionInput = 'Altered input'
  expect(restoreResultApproval(result, take).cautionCheck.verdict).toBe('refuted')
})
it('preserves a separately approved bound caution when the result summary is withheld', () => {
  const { result, handoff, plan, response } = setup(); response.caution_supported = true; response.summary.supported = false
  const take = applyResultApproval(handoff, plan, response, 'The analysis has limitations.')
  const restored = restoreResultApproval(result, take)
  expect(restored.finding).toBe(''); expect(restored.designCaution).toBe(take.designCaution)
  result.sourceDoc.text += ' Changed.'
  expect(restoreResultApproval(result, take).designCaution).toBe('')
})
it('does not equate token presence with tuple proof', () => {
  const result = fixture(); result.rows[0].quantity.source_quote = quote.replace('95% CI', 'CI')
  result.sourceDoc.text = result.sourceDoc.text.replace('95% CI', 'CI')
  result.resultContexts.forEach(c => { for (const f of Object.values(c)) if (f?.quote) f.quote = f.quote.replace('95% CI', 'CI') })
  const handoff = buildResultHandoff(result)
  expect(handoff.records[0].numericStatus).toBe('tokens-present-tuple-unproven')
  expect(handoff.records[0].numeric).toBe(false)
})

// Needs the branch's lib/claimCheck.js and lib/digestStore.js wiring, which the review packet did not include.
it.skip('fails new-contract missing approvals closed across both restore paths, preserving legacy behavior', async () => {
  const { currentResultPaper } = await import('./resultHandoff.js')
  const { regateTriaged } = await import('../lib/digestStore.js')
  const { result, handoff, plan, response } = setup(); response.caution_supported = true
  const take = applyResultApproval(handoff, plan, response, 'The analysis has limitations.')
  const missing = { ...take }; delete missing.resultApproval
  const paper = { ...missing, id: result.paper.id, fullText: result.sourceDoc.text, tables: '', resultContexts: result.resultContexts, quantities: result.rows.map(r => r.quantity) }
  expect(currentResultPaper(paper).finding).toBe('')
  expect(currentResultPaper(paper).designCaution).toBe('')
  const digest = regateTriaged({ paper: missing }, [result]).paper
  expect(digest.finding).toBe(''); expect(digest.designCaution).toBe('')
  const legacy = { id: 'old', finding: 'A legacy qualitative finding.', check: { verdict: 'supported' } }
  expect(currentResultPaper(legacy)).toBe(legacy)
  expect(regateTriaged({ old: legacy }, []).old).toBe(legacy)
})
// Needs the branch's lib/claimCheck.js and lib/digestStore.js wiring, which the review packet did not include.
it.skip('revalidates caution-only digest records even when finding is empty', async () => {
  const { regateTriaged } = await import('../lib/digestStore.js')
  const { result, handoff, plan, response } = setup(); response.summary.supported = false; response.caution_supported = true
  const take = applyResultApproval(handoff, plan, response, 'The analysis has limitations.')
  result.sourceDoc.text += ' Changed.'
  expect(regateTriaged({ paper: take }, [result]).paper.designCaution).toBe('')
})

it.each([
  ['outcomeTimepoint', 'day 30 onward'], ['outcomeTimepoint', '24 weeks'],
  ['analysis', '1-stage stratified Cox'], ['outcome', '1. major bleeding'],
  ['outcome', 'bleeding types 3 or 5'],
])('preserves source-literal contextual numbers in %s: %s', (key, text) => {
  const result = fixture(); result.sourceDoc.text += ` ${text}.`
  result.resultContexts[0][key] = field(text, `${text}.`)
  expect(buildResultHandoff(result).records.map(r => r.rowIndex)).toContain(0)
})
it.each([['endpointRole', '30-day MACEs'], ['qualification', 'bleeding at 30 days'], ['intervention', 'bypasses longer than 75 mm'], ['comparator', 'aneurysms ≤ 20 mm']])('preserves typed contextual numbers in %s: %s', (key, text) => {
  const result = fixture(); result.sourceDoc.text += ` ${text}.`
  if (key === 'qualification') result.resultContexts[0].qualifications.push(field(text, `${text}.`))
  else result.resultContexts[0][key] = field(text, `${text}.`)
  const handoff = buildResultHandoff(result)
  expect(handoff.records.map(r => r.rowIndex)).toContain(0)
  expect(handoff.diagnostics).toEqual([])
})
it.each(['HR 0.44', 'CI 0.34–0.55', 'P = 0.01', 'mortality 40%', 'n = 638'])('withholds a qualification carrying a statistic and keeps the sourced result: %s', text => {
  const result = fixture(); result.sourceDoc.text += ` ${text}.`
  result.resultContexts[0].qualifications.push(field(text, `${text}.`))
  const handoff = buildResultHandoff(result)
  expect(handoff.records[0].qualifications).toEqual([])
  expect(handoff.records[0].withheldQualifications).toEqual([{ field: 'qualification-0', reason: 'unsupported-context-number', text }])
  expect(handoff.diagnostics).toEqual([{ quantityIndex: 0, withheld: [{ field: 'qualification-0', reason: 'unsupported-context-number' }] }])
  expect(renderResult(handoff.records[0], { includeEstimate: false })).not.toContain(text)
})
it('accepts a label that drops or reorders quote words and rejects one that adds any', () => {
  const result = fixture(); result.sourceDoc.text += ' Third, bleeding complications were not systematically captured.'
  const quote = 'Third, bleeding complications were not systematically captured.'
  result.resultContexts[0].qualifications.push(field('bleeding complications not systematically captured', quote), field('bleeding complications were not captured systematically', quote))
  const ok = buildResultHandoff(result)
  expect(ok.records[0].qualifications.map(q => q.fidelity)).toEqual(['paraphrase', 'paraphrase'])
  result.resultContexts[0].qualifications = [field('bleeding complications were not captured in any center', quote)]
  expect(buildResultHandoff(result).records[0].withheldQualifications[0].reason).toBe('label-not-in-quote')
  result.resultContexts[0].effect = field('treatment A reduced bleeding', quote.replace('bleeding', 'bleeding'))
  expect(buildResultHandoff(result).diagnostics[0].failures).toEqual([{ field: 'effect', reason: 'label-not-in-quote' }])
})
it('requires a comparison to be whole: intervention without comparator, or effect alone, is neither comparative nor descriptive', () => {
  for (const [drop, missing] of [[['comparator'], ['comparator']], [['intervention', 'comparator'], ['intervention', 'comparator']], [['intervention', 'effect'], ['intervention', 'effect']]]) {
    const result = fixture(); for (const k of drop) result.resultContexts[0][k] = null
    const handoff = buildResultHandoff(result)
    expect(handoff.records.map(r => r.rowIndex)).toEqual([1])
    expect(handoff.diagnostics[0]).toEqual({ quantityIndex: 0, failures: [], missing })
  }
})
it('renders a descriptive result with no comparison template and only with its verified tuple', () => {
  const result = fixture(); result.sourceDoc.text += ' Overall survival was 90.3%.'
  result.rows.push({ quantity: { name: 'Survival', quantity_type: 'single', source_quote: 'Overall survival was 90.3%.', unit: '%', value: 90.3, ci_low: null, ci_high: null } })
  result.resultContexts.push({ quantity_index: 2, outcome: field('Overall survival', 'Overall survival was 90.3%.'), intervention: null, comparator: null, analysis: null,
    interventionTiming: null, outcomeTimepoint: null, endpointRole: null, analysisRole: null, effect: null, qualifications: [] })
  const handoff = buildResultHandoff(result)
  const record = handoff.records.find(r => r.rowIndex === 2)
  expect(record.kind).toBe('descriptive')
  expect(record.numeric).toBe(false)
  expect(prepareResultPlan(handoff, [{ id: record.id, includeEstimate: true }])).toEqual([])
  expect(renderResult({ ...record, numeric: true }, { includeEstimate: true })).toBe('Overall survival. Estimate: 90.3%.')
  expect(renderResult({ ...record, numeric: true }, { includeEstimate: true })).not.toContain('versus')
})
it.each(['HR 0.44', 'CI 0.34–0.55', 'P = 0.01', 'mortality 40%'])('rejects statistical numbers smuggled into labels with diagnostics: %s', text => {
  const result = fixture(); result.sourceDoc.text += ` ${text}.`
  result.resultContexts[0].analysis = field(text, `${text}.`)
  const handoff = buildResultHandoff(result)
  expect(handoff.records.map(r => r.rowIndex)).not.toContain(0)
  expect(handoff.diagnostics[0].failures).toContainEqual({ field: 'analysis', reason: 'unsupported-context-number' })
})
