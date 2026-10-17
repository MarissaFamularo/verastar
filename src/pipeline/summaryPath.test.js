// summaryPath.test.js — the obligation path in triage(): writer → number guard + binding →
// structured checker → ONE rewrite → deterministic consequences (validated / excerpt /
// unavailable), the stale-approval invalidation on restore, complete evidence passages and
// the extraction contract. Model calls are mocked; the plumbing is what is locked here.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/anthropic.js', () => ({
  MODELS: { extraction: 'x-extract', triage: 'x-write', interview: 'x', fast: 'x-check' },
  extractStructured: vi.fn(),
}))

import { extractStructured } from '../lib/anthropic.js'
import { triage, TRIAGE_SCHEMA, UNAVAILABLE_SUMMARY_REASON, EXCERPT_LABEL, RANKING_BATCH_LIMIT, buildExcerpt } from './triage.js'
import { SUMMARY_CHECK_SCHEMA, evaluateSummaryCheck, rewriteInstructions } from './summaryCheck.js'
import { resultCandidate, buildResultHandoff, restoreSummaryApproval, currentResultPaper, normalizeResultContexts, STALE_SUMMARY_REASON, HANDOFF_VERSION } from './resultHandoff.js'
import { buildObligations } from './obligations.js'
import { regateTriaged } from '../lib/digestStore.js'
import { buildPaperRecord } from './save.js'
import { usableFinding } from '../lib/findingGate.js'
import { completeEvidence, completeEvidenceFor, COMPLETE_WINDOW_CHARS } from './evidencePassages.js'
import { encodeCachedExtraction, cacheWireExtraction, validateWireExtraction } from '../../supabase/functions/_shared/extractionContract.js'

const SOURCE = 'Title.\n\nMETHODS: The primary outcome was major amputation at one year. Secondary outcomes were death and restenosis.\nRESULTS: Amputation did not differ (OR 1.45, 95% CI 0.91 to 2.29; P = 0.12; low-certainty evidence). Death did not differ (OR 0.97).\nCONCLUSION: Drug-coated balloons reduce restenosis but clinical benefit is unproven. More trials are needed.'
const span = (text, quote) => ({ text, quote, corpus: 'text' })
const quantity = (name, value, quote, extra = {}) => ({ name, quantity_type: 'single', value, range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, unit: 'odds ratio', ci_low: null, ci_high: null, p_value: null, source_quote: quote, location_hint: 'Results', ...extra })
const unverified = { tier: 'source-located', flagged: true, relationshipValidated: false, verificationVersion: '2026-10-16.estimates-v14' }
const verified = { tier: 'verified-estimate', flagged: false, relationshipValidated: true, verificationVersion: '2026-10-16.estimates-v14' }
const AMP_QUOTE = 'Amputation did not differ (OR 1.45, 95% CI 0.91 to 2.29; P = 0.12; low-certainty evidence).'
function makeResult() {
  return {
    paper: { id: 'p1', pmid: 'p1', title: 'DEB versus POBA' }, design: 'meta_analysis', source: { tier: 'abstract_only', hash: 'a'.repeat(64) },
    sourceDoc: { text: SOURCE, tables: '' },
    rows: [
      { quantity: quantity('Amputation at one year, DEB vs POBA', 1.45, AMP_QUOTE, { ci_low: 0.91, ci_high: 2.29, p_value: 0.12 }), verdict: verified },
      { quantity: quantity('Death, DEB vs POBA', 0.97, 'Death did not differ (OR 0.97).'), verdict: unverified },
    ],
    resultContexts: [{
      quantity_index: 0, outcome: span('Amputation', AMP_QUOTE), intervention: span('DEB', 'DEB versus POBA'), comparator: null, analysis: null, interventionTiming: null, outcomeTimepoint: null,
      endpointRole: span('primary outcome', 'The primary outcome was major amputation at one year.'), analysisRole: null, effect: span('did not differ', AMP_QUOTE),
      qualifications: [span('low-certainty evidence', 'low-certainty evidence')], conflictingAnalyses: [],
    }],
  }
}
function makeCandidate(result = makeResult()) {
  return {
    id: 'p1', title: result.paper.title, design: result.design, summary: 'x',
    ...resultCandidate(result),
    primary: { state: 'unknown', name: null, verified: false, indexes: [], basis: null },
    verified: result.rows.filter((r) => !r.verdict.flagged).map((r) => ({ name: r.quantity.name, value: '1.45 odds ratio (CI 0.91–2.29), P=0.12', quote: r.quantity.source_quote })),
  }
}
const ranking = (finding, over = {}) => ({ id: 'p1', score: 70, tier: 1, finding, finding_plain: finding.replace(/\(.*\)/, '').trim(), design_caution: 'Pooled trials were not powered for clinical endpoints.', relevance: 'Touches your limb preservation work.', ...over })
const GOOD = 'Drug-coated balloons showed no statistically clear difference in one-year amputation versus plain balloons (1.45 odds ratio (CI 0.91–2.29), P=0.12), with low-certainty evidence for the clinical endpoints, and the authors call clinical benefit unproven.'

// A checker response that passes everything the request lists, with overrides.
function checkerResponse(content, over = {}) {
  const obligations = [...content.matchAll(/\[(ob\d+)\]/g)].map((m) => ({ id: m[1], status: 'present', quote: '', reason: 'carried' }))
  const numbers = [...content.matchAll(/\[number ([^\]\s]+)/g)].map((m) => ({ number: m[1], row_id: '0', outcome_ok: true, comparator_ok: true, analysis_ok: true, timepoint_ok: true, direction_ok: true, quote: AMP_QUOTE, reason: 'matches' }))
  const base = {
    obligations, number_bindings: numbers,
    equivalence_from_nonsignificant: { failed: false, quote: '', reason: '' },
    causal_overclaim: { failed: false, quote: '', reason: '' },
    certainty_overclaim: { failed: false, quote: '', reason: '' },
    refutation: { refuted: false, quote: '', reason: '' },
    caution: { supported: true, quote: 'none of the studies were powered', reason: 'Methods state it.' },
  }
  const out = { ...base, ...over }
  if (over.obligationStatus) out.obligations = obligations.map((o) => ({ ...o, ...(over.obligationStatus[o.id] || {}) }))
  return out
}

function script({ writer = [], checker = [] }) {
  const calls = []
  extractStructured.mockImplementation(async (req) => {
    calls.push(req)
    if (req.schema === TRIAGE_SCHEMA) return { rankings: [writer.shift()(req)] }
    if (req.schema === SUMMARY_CHECK_SCHEMA) {
      const next = checker.shift()
      if (next instanceof Error) throw next
      return next(req.content, req)
    }
    throw new Error(`unexpected schema in test: ${JSON.stringify(req.schema).slice(0, 60)}`)
  })
  return calls
}

beforeEach(() => { extractStructured.mockReset() })

describe('triage — obligation path', () => {
  it('a finding that passes every check renders as a validated summary with an approval bound to the handoff', async () => {
    const calls = script({ writer: [() => ranking(GOOD)], checker: [(c) => checkerResponse(c)] })
    const [take] = await triage({ candidates: [makeCandidate()] })
    expect(take).toMatchObject({ id: 'p1', finding: GOOD, summaryKind: 'validated', check: { verdict: 'supported' }, cautionCheck: { verdict: 'supported' }, rewriteUsed: false, checkerModel: 'x-check' })
    expect(take.designCaution).toBe('Pooled trials were not powered for clinical endpoints.')
    expect(take.summaryApproval).toMatchObject({ contract: HANDOFF_VERSION, finding: GOOD, summaryKind: 'validated', checkerModel: 'x-check', writerModel: 'x-write' })
    expect(calls.map((c) => c.model)).toEqual(['x-write', 'x-check'])
    // The writer saw the obligations and the located primary; the checker saw the complete evidence and bindings.
    expect(calls[0].content).toMatch(/Coverage obligations/)
    expect(calls[0].content).toMatch(/\[ob1\] \(endpoint-role\) "The primary outcome was major amputation at one year\."/)
    expect(calls[0].content).toMatch(/Primary result \(established by a located endpoint-role quote\): Amputation at one year, DEB vs POBA \(verified/)
    expect(calls[1].content).toMatch(/EVIDENCE \(complete passages, verbatim\):\n\[Evidence window: the paper's complete abstract\]/)
    expect(calls[1].content).toMatch(/\[number 1.45 with interval 0.91–2.29\].*bound to result 0/)
    expect(calls[1].content).toContain('context: outcome: "Amputation"')
  })

  it('a failed check triggers ONE targeted rewrite naming the failures, and a passing rewrite renders', async () => {
    const REWRITTEN = GOOD.replace('with low-certainty evidence', 'with low-certainty evidence for every clinical endpoint')
    const calls = script({
      writer: [() => ranking(GOOD), (req) => { expect(req.system).toMatch(/REWRITE REQUEST/); expect(req.system).toMatch(/Obligation ob2 absent and material: omitted the certainty grade/); return ranking(REWRITTEN) }],
      checker: [(c) => checkerResponse(c, { obligationStatus: { ob2: { status: 'absent-material', quote: 'low-certainty evidence', reason: 'omitted the certainty grade' } } }), (c) => checkerResponse(c)],
    })
    const [take] = await triage({ candidates: [makeCandidate()] })
    expect(take).toMatchObject({ finding: REWRITTEN, summaryKind: 'validated', rewriteUsed: true })
    expect(calls.map((c) => c.model)).toEqual(['x-write', 'x-check', 'x-write', 'x-check'])
  })

  it('a contradiction that survives the rewrite removes the claim: nothing displayable, an explicit notice', async () => {
    const refuted = (c) => checkerResponse(c, { refutation: { refuted: true, quote: AMP_QUOTE, reason: 'the source reports no difference' } })
    script({ writer: [() => ranking('DEB reduced amputation (1.45 odds ratio (CI 0.91–2.29), P=0.12).'), () => ranking('DEB reduced amputation (1.45 odds ratio (CI 0.91–2.29), P=0.12).')], checker: [refuted, refuted] })
    const [take] = await triage({ candidates: [makeCandidate()] })
    expect(take).toMatchObject({ finding: '', summaryKind: 'unavailable', summaryReason: UNAVAILABLE_SUMMARY_REASON, check: { verdict: 'refuted' }, rewriteUsed: true })
    expect(take.check.reason).toMatch(/contradiction: the source reports no difference/)
    expect(take.summaryChecks.find((f) => f.check === 'refutation').quote).toBe(AMP_QUOTE)
  })

  it.each([
    ['equivalence from a nonsignificant comparison', { equivalence_from_nonsignificant: { failed: true, quote: AMP_QUOTE, reason: 'states as safe' } }],
    ['causal language the design does not support', { causal_overclaim: { failed: true, quote: 'Pooled trials', reason: 'observational' } }],
    ['certainty stronger than the source grade', { certainty_overclaim: { failed: true, quote: 'low-certainty evidence', reason: 'says clearly' } }],
    ['a number bound to the wrong outcome', { number_bindings: [{ number: '1.45', row_id: '0', outcome_ok: false, comparator_ok: true, analysis_ok: true, timepoint_ok: true, direction_ok: true, quote: AMP_QUOTE, reason: 'wrong outcome' }] }],
  ])('%s surviving the rewrite removes the claim rather than keeping it with a quote beneath', async (_label, over) => {
    script({ writer: [() => ranking(GOOD), () => ranking(GOOD)], checker: [(c) => checkerResponse(c, over), (c) => checkerResponse(c, over)] })
    const [take] = await triage({ candidates: [makeCandidate()] })
    expect(take.summaryKind).toBe('unavailable')
    expect(take.finding).toBe('')
  })

  it('a material omission that survives the rewrite is replaced by a labelled verbatim excerpt, counted separately', async () => {
    const omit = (c) => checkerResponse(c, { obligationStatus: { ob2: { status: 'absent-material', quote: 'low-certainty evidence', reason: 'omits the grade' }, ob3: { status: 'absent-immaterial', reason: 'conclusion restated' } } })
    const bare = 'Drug-coated balloons showed no statistically clear difference in one-year amputation versus plain balloons (1.45 odds ratio (CI 0.91–2.29), P=0.12).'
    script({ writer: [() => ranking(bare), () => ranking(bare)], checker: [omit, omit] })
    const [take] = await triage({ candidates: [makeCandidate()] })
    expect(take.summaryKind).toBe('excerpt')
    expect(take.finding.startsWith(EXCERPT_LABEL)).toBe(true)
    expect(take.finding).toContain('“low-certainty evidence”')
    expect(take.finding).toContain(`“${AMP_QUOTE}”`) // the primary result's own quote leads
    expect(take.finding).not.toContain('no statistically clear difference') // never the withheld prose plus a quote
    expect(take.check.verdict).toBe('excerpt')
    expect(take.summaryApproval.summaryKind).toBe('excerpt')
  })

  it('a checker that cannot answer never approves: the paper is unavailable, with the reason', async () => {
    script({ writer: [() => ranking(GOOD)], checker: [new Error('network down')] })
    const [take] = await triage({ candidates: [makeCandidate()] })
    expect(take).toMatchObject({ finding: '', summaryKind: 'unavailable', score: 70 })
    expect(take.summaryReason).toMatch(/Summary check unavailable: network down/)
  })

  it('an unverified number with no clean fallback is a wrong-binding failure: one rewrite, then withheld', async () => {
    const bad = () => ranking('DEB showed no clear difference in amputation (OR 1.46).', { finding_plain: 'DEB had 2 trials.' })
    const calls = script({ writer: [bad, bad], checker: [] })
    const [take] = await triage({ candidates: [makeCandidate()] })
    expect(take.summaryKind).toBe('unavailable')
    expect(calls.map((c) => c.model)).toEqual(['x-write', 'x-write'])
  })

  it('a caution the checker does not support is dropped while the finding stays', async () => {
    script({ writer: [() => ranking(GOOD)], checker: [(c) => checkerResponse(c, { caution: { supported: false, quote: '', reason: 'The source does not state power.' } })] })
    const [take] = await triage({ candidates: [makeCandidate()] })
    expect(take).toMatchObject({ summaryKind: 'validated', designCaution: '', cautionCheck: { verdict: 'refuted' } })
  })

  it('writer batches are bounded and every paper is checked on its own', async () => {
    const candidates = Array.from({ length: 4 }, (_, i) => ({ ...makeCandidate(), id: `p${i}` }))
    const writer = []
    const seen = []
    extractStructured.mockImplementation(async (req) => {
      if (req.schema === TRIAGE_SCHEMA) {
        const ids = [...req.content.matchAll(/^\[(p\d)\]/gm)].map((m) => m[1])
        writer.push(ids)
        return { rankings: ids.map((id) => ({ ...ranking(GOOD), id })) }
      }
      seen.push(req.content.match(/^PAPER \[(p\d)\]/)[1])
      return checkerResponse(req.content)
    })
    const takes = await triage({ candidates })
    expect(writer).toEqual([['p0', 'p1', 'p2'], ['p3']])
    expect(RANKING_BATCH_LIMIT).toBe(3)
    expect(seen).toEqual(['p0', 'p1', 'p2', 'p3'])
    expect(takes.map((t) => t.summaryKind)).toEqual(['validated', 'validated', 'validated', 'validated'])
  })

  it('a writer response with a missing or foreign id is refused, never mapped', async () => {
    extractStructured.mockResolvedValue({ rankings: [{ ...ranking(GOOD), id: 'p9' }] })
    await expect(triage({ candidates: [makeCandidate()] })).rejects.toThrow(/Invalid ranking identity/)
  })

  it('a paper whose complete evidence is unavailable is unavailable before any model call', async () => {
    const calls = script({ writer: [], checker: [] })
    const c = makeCandidate()
    const [take] = await triage({ candidates: [{ ...c, evidence: '' }] })
    expect(take).toMatchObject({ summaryKind: 'unavailable', finding: '' })
    expect(calls).toEqual([])
  })

  it('the production path is untouched for candidates without a handoff', async () => {
    extractStructured.mockResolvedValueOnce({ rankings: [ranking('Improved outcomes.')] }).mockResolvedValueOnce({ verdicts: [{ id: 'p1', supported: true, reason: 'ok' }, { id: 'design-caution:p1', supported: true, reason: 'ok' }] })
    const [take] = await triage({ candidates: [{ id: 'p1', title: 't', summary: 'snippet', verified: [] }] })
    expect(take.summaryKind).toBeUndefined()
    expect(take).toMatchObject({ finding: 'Improved outcomes.', check: { verdict: 'supported' } })
  })
})

describe('evaluateSummaryCheck — deterministic consequences', () => {
  const obligations = [{ id: 'ob1', quote: 'q1' }, { id: 'ob2', quote: 'q2' }]
  const bindings = [{ number: 1.45 }]
  it('an obligation or number the checker did not report fails closed', () => {
    const ev = evaluateSummaryCheck({ obligations: [{ id: 'ob1', status: 'present', quote: '', reason: '' }], number_bindings: [] }, { obligations, bindings })
    expect(ev.verdict).toBe('fail')
    expect(ev.blocking.map((f) => f.kind)).toEqual(['unreported-obligation', 'unreported-binding'])
    expect(ev.categories).toMatchObject({ materialOmission: true, wrongBinding: true })
  })
  it('a "present" whose reason admits missing evidence counts as absent-material', () => {
    const ev = evaluateSummaryCheck({ obligations: [{ id: 'ob1', status: 'present', quote: 'q1', reason: 'the source does not state this' }, { id: 'ob2', status: 'absent-immaterial', quote: 'q2', reason: 'restated' }], number_bindings: [] }, { obligations, bindings: [] })
    expect(ev.blocking.map((f) => [f.id, f.kind])).toEqual([['ob1', 'absent-material']])
    expect(ev.failures.find((f) => f.id === 'ob2').informational).toBe(true)
  })
  it('every negative verdict carries its quote, and a missing quote is flagged', () => {
    const ev = evaluateSummaryCheck({ obligations: [], number_bindings: [], refutation: { refuted: true, quote: '', reason: 'reversed' } }, { obligations: [], bindings: [] })
    expect(ev.blocking[0]).toMatchObject({ kind: 'contradiction', quoteMissing: true })
    expect(rewriteInstructions(ev)).toMatch(/REWRITE REQUEST[\s\S]*contradiction: reversed/)
  })
})

describe('stale-approval invalidation', () => {
  async function approvedTake() {
    script({ writer: [() => ranking(GOOD)], checker: [(c) => checkerResponse(c)] })
    const [take] = await triage({ candidates: [makeCandidate()] })
    return take
  }
  it('a restored take matching its source, proposals, text and contract is kept', async () => {
    const take = await approvedTake()
    expect(restoreSummaryApproval(makeResult(), take)).toEqual(take)
    expect(regateTriaged({ p1: take }, [makeResult()]).p1).toEqual(take)
  })
  it.each([
    ['the saved source text changed', (r) => ({ ...r, sourceDoc: { text: r.sourceDoc.text + ' Added sentence.', tables: '' } }), (t) => t],
    ['the source hash changed', (r) => ({ ...r, source: { ...r.source, hash: 'b'.repeat(64) } }), (t) => t],
    ['a proposed span changed', (r) => ({ ...r, resultContexts: [{ ...r.resultContexts[0], effect: null }] }), (t) => t],
    ['the approved finding text changed', (r) => r, (t) => ({ ...t, finding: t.finding + ' Also safe.' })],
    ['the contract version changed', (r) => r, (t) => ({ ...t, summaryApproval: { ...t.summaryApproval, contract: 'result-handoff-v0' } })],
    ['the approval is missing', (r) => r, (t) => ({ ...t, summaryApproval: undefined })],
  ])('withholds the summary when %s', async (_label, mutateResult, mutateTake) => {
    const take = mutateTake(await approvedTake())
    const out = restoreSummaryApproval(mutateResult(makeResult()), take)
    expect(out).toMatchObject({ finding: '', summaryKind: 'unavailable', summaryReason: STALE_SUMMARY_REASON, check: { verdict: 'refuted' } })
    expect(regateTriaged({ p1: take }, [mutateResult(makeResult())]).p1.finding).toBe('')
  })
  it('a changed caution drops only the caution', async () => {
    const take = await approvedTake()
    const out = restoreSummaryApproval(makeResult(), { ...take, designCaution: 'An invented limitation.' })
    expect(out).toMatchObject({ finding: GOOD, designCaution: '', cautionCheck: { verdict: 'refuted' } })
  })
  it('a saved Library record re-derives its approval from its own saved source and proposals', async () => {
    const take = await approvedTake()
    const record = buildPaperRecord(makeResult(), take, { title: 'DEB versus POBA' })
    expect(record).toMatchObject({ summaryKind: 'validated', resultContexts: makeResult().resultContexts })
    expect(usableFinding(record)).toBe(GOOD)
    expect(currentResultPaper(record).summaryKind).toBe('validated')
    expect(usableFinding({ ...record, fullText: 'A different paper.' })).toBe('')
    expect(currentResultPaper({ ...record, fullText: 'A different paper.' })).toMatchObject({ summaryKind: 'unavailable' })
    // A legacy record (no approval) keeps the production policy.
    expect(usableFinding({ finding: 'Legacy.', check: { verdict: 'unchecked' } })).toBe('Legacy.')
  })
  it('the handoff key changes with the source, the proposals and the quantities, not with the finding', () => {
    const a = buildResultHandoff(makeResult()).key
    expect(buildResultHandoff(makeResult()).key).toBe(a)
    const r = makeResult()
    expect(buildResultHandoff({ ...r, sourceDoc: { text: r.sourceDoc.text + '.', tables: '' } }).key).not.toBe(a)
    expect(buildResultHandoff({ ...r, rows: [r.rows[0]] }).key).not.toBe(a)
  })
})

describe('buildExcerpt', () => {
  it('quotes whole located passages in source order and never the withheld prose', () => {
    const handoff = buildResultHandoff(makeResult())
    const { obligations } = buildObligations(handoff, { abstract: SOURCE })
    const material = obligations.filter((o) => o.kind === 'qualification')
    const out = buildExcerpt({ handoff, obligations, failures: material.map((o) => ({ check: 'obligation', kind: 'absent-material', id: o.id })), primary: { state: 'identified', indexes: [0] } })
    expect(out.text).toBe(`${EXCERPT_LABEL} “${AMP_QUOTE}” … “low-certainty evidence”`)
    expect(out.spans.map((s) => s.kind)).toEqual(['primary-result', 'qualification'])
  })
})

describe('complete evidence passages', () => {
  it('an abstract-only source is sent whole with its labelled parts', () => {
    const w = completeEvidence({ tier: 'abstract_only', text: SOURCE })
    expect(w.kind).toBe('abstract')
    expect(w.text).toMatch(/^\[Evidence window: the paper's complete abstract\]\nMETHODS: The primary outcome/)
    expect(w.text).toContain('CONCLUSION: Drug-coated balloons reduce restenosis')
    expect(w.blocked).toBe(false)
  })
  it('full text keeps the complete abstract and every outermost Results section, not nested duplicates', () => {
    const sections = [
      { label: 'Introduction', kind: 'background', depth: 0, parent: -1, text: 'Background.' },
      { label: 'Results', kind: 'results', depth: 0, parent: -1, text: 'Overall results. Late exception: the weighted analysis was not significant.' },
      { label: 'Results › Survival', kind: 'results', depth: 1, parent: 1, text: 'Late exception: the weighted analysis was not significant.' },
    ]
    const w = completeEvidence({ tier: 'full_text', text: 'body', abstractParts: [{ label: 'Methods', text: 'Design.' }], sections })
    expect(w.kind).toBe('results')
    expect(w.text.match(/Late exception/g)).toHaveLength(1)
    expect(w.text).toContain('METHODS (abstract): Design.')
    expect(w.text).not.toContain('Background.')
  })
  it('oversized evidence is blocked explicitly, never truncated', () => {
    const w = completeEvidence({ tier: 'abstract_only', text: 'x'.repeat(COMPLETE_WINDOW_CHARS + 10) })
    expect(w).toMatchObject({ kind: 'unavailable', blocked: true, text: '' })
  })
  it('an older full-text result without its section tree gets the whole saved corpus with honest provenance', () => {
    const w = completeEvidenceFor({ source: { tier: 'full_text' }, sourceDoc: { text: 'Whole body.', tables: 'T' } })
    expect(w.text).toBe('[Complete saved full-text source; original section structure unavailable]\nWhole body.\nTABLES:\nT')
    expect(w.legacy).toBe(true)
  })
})

describe('extraction contract', () => {
  const wireContext = { quantity_index: 0, outcome: [span('a', 'a b')], intervention: [], comparator: [], analysis: [], interventionTiming: [], outcomeTimepoint: [], endpointRole: [], analysisRole: [], effect: [], qualifications: [], conflictingAnalyses: [span('c', 'c d')] }
  it('normalizes wire arrays to null-or-span, tolerates a missing conflictingAnalyses list, and passes saved form through', () => {
    const [n] = normalizeResultContexts([wireContext])
    expect(n).toMatchObject({ quantity_index: 0, outcome: span('a', 'a b'), intervention: null, conflictingAnalyses: [span('c', 'c d')] })
    const legacy = { ...wireContext }
    delete legacy.conflictingAnalyses
    expect(normalizeResultContexts([legacy])[0].conflictingAnalyses).toEqual([])
    expect(normalizeResultContexts([n])).toEqual([n])
  })
  it('refuses malformed contexts instead of choosing a span', () => {
    expect(() => normalizeResultContexts([{ ...wireContext, outcome: [span('a', 'a'), span('b', 'b')] }])).toThrow(/expected-zero-or-one-valid-span/)
    expect(() => normalizeResultContexts([{ ...wireContext, extra: 1 }])).toThrow(/malformed-context/)
    expect(() => normalizeResultContexts('nope')).toThrow(/not-array/)
  })
  it('round-trips the cache envelope and refuses untagged, foreign or malformed rows', () => {
    const extraction = { study_id: 'p1', design: 'RCT', quantities: [quantity('x', 1, 'q')], result_contexts: normalizeResultContexts([wireContext]) }
    const env = encodeCachedExtraction(extraction, 'p1')
    expect(env.format).toBe('extraction-wire-v2')
    expect(cacheWireExtraction(env, 'p1').result_contexts[0].outcome).toEqual([span('a', 'a b')])
    expect(() => cacheWireExtraction(env, 'p2')).toThrow(/study_id/)
    expect(() => cacheWireExtraction(env.value, 'p1')).toThrow(/unsupported cache representation/)
    expect(() => validateWireExtraction({ ...env.value, result_contexts: [{ ...wireContext, quantity_index: 5 }] }, 'p1')).toThrow(/quantity_index/)
  })
})
