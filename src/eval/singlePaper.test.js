// The single-paper harness, fully offline. The paper is a SYNTHETIC PMC record invented
// for this test; the "model" is a fake provider. Nothing here measures model quality.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { DOMParser } from 'linkedom'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const anthropic = vi.hoisted(() => ({ extractStructured: vi.fn() }))
vi.mock('../lib/anthropic.js', async (importOriginal) => ({ ...(await importOriginal()), extractStructured: anthropic.extractStructured }))

import Anthropic from '@anthropic-ai/sdk'
import { planSinglePaper, runSinglePaper, compareToReference, requestChargeBoundUsd, makeLiveProvider, liveRequestBody, requestSettings, LIVE_TIMEOUT_MS } from './singlePaper.js'
import { EXTRACTION_SYSTEM, EXTRACTION_SCHEMA, EXTRACTION_MAX_TOKENS } from '../pipeline/extract.js'
import { extractQuantities } from '../pipeline/extract.js'
import { createHash } from 'node:crypto'
import { main, liveGate, authorizationFor, parseArgs } from '../../scripts/eval-single-paper.mjs'

const SYNTH = `<?xml version="1.0"?><pmc-articleset><article><front><article-meta>
<abstract><sec><title>Methods</title><p>Adults were randomized to stenting or surgery.</p></sec><sec><title>Results</title><p>No difference.</p></sec></abstract>
</article-meta></front><body>
<sec sec-type="intro"><title>Introduction</title><p>A prior trial reported a hazard ratio of 0.50 (95% CI 0.40-0.62) [3].</p></sec>
<sec sec-type="results"><title>Results</title><p>The primary end point occurred in 7.2% and 6.8% (hazard ratio, 1.11; 95% CI, 0.81 to 1.51; P = 0.51). Myocardial infarction occurred in 1.1% vs. 2.3%, P = 0.03.</p></sec>
</body></article></pmc-articleset>`

const FAKE = {
  study_id: '1',
  design: 'RCT',
  quantities: [
    { name: 'primary composite, stenting vs surgery (HR)', quantity_type: 'single', value: 1.11, range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, unit: 'HR', ci_low: 0.81, ci_high: 1.51, p_value: 0.51, source_quote: 'hazard ratio, 1.11; 95% CI, 0.81 to 1.51; P = 0.51', location_hint: 'Results' },
    // Arms reversed relative to the reference (stenting first).
    { name: 'periprocedural MI', quantity_type: 'comparison', value: null, range_low: null, range_high: null, first_label: null, first_value: 2.3, second_label: null, second_value: 1.1, unit: '%', ci_low: null, ci_high: null, p_value: null, source_quote: 'Myocardial infarction occurred in 1.1% vs. 2.3%', location_hint: 'Results' },
  ],
}

const REFERENCE = {
  adjudicationStatus: 'adjudicated',
  items: [
    { id: 'primary', status: 'source-supported', expected: { value: 1.11, ci_low: 0.81, ci_high: 1.51, p_value: 0.51 } },
    { id: 'mi', status: 'source-supported', expected: { first_value: 1.1, second_value: 2.3, p_value: 0.03 } },
    { id: 'stroke-or-death', status: 'source-supported', expected: { value: 1.5, ci_low: 1.05, ci_high: 2.15 } },
    { id: 'clinical-weight', status: 'needs-clinical-judgment' },
  ],
}

const realParser = globalThis.DOMParser
beforeAll(() => { globalThis.DOMParser = DOMParser })
afterAll(() => { globalThis.DOMParser = realParser })

describe('planning makes no model call', () => {
  it('parses one source, hashes it and builds the window without any provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const plan = await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH })
    expect(plan.sourceTier).toBe('full_text')
    expect(plan.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.evidenceWindow.kind).toBe('results')
    expect(plan.model).toBeNull()
    expect(plan.chargeBoundUsd).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(anthropic.extractStructured).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
  it('the planned request is exactly the one extractQuantities sends', async () => {
    const plan = await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, model: 'claude-sonnet-5-5' })
    anthropic.extractStructured.mockResolvedValueOnce({ study_id: '1', design: 'RCT', quantities: [] })
    const sourceText = plan.assembled.modelText
    await extractQuantities({ studyId: '1', sourceText, model: 'claude-sonnet-5-5' })
    const sent = anthropic.extractStructured.mock.calls[0][0]
    for (const key of ['model', 'system', 'content', 'schema', 'maxTokens', 'thinking']) expect(plan.request[key]).toEqual(sent[key])
  })
  // Codex R2 P1: the old "bound" counted bytes, which proves nothing about billable tokens.
  it('the charge bound is the conservative context-window bound; the byte figure is only a labelled estimate', async () => {
    const plan = await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, model: 'claude-sonnet-5-5', maxUsd: 5 })
    // claude-sonnet-5-5: 1,000,000 input tokens at $2/M + 8,192 output tokens at $10/M.
    expect(plan.chargeBoundUsd).toBeCloseTo(2 + 8192 * 10 / 1e6, 6)
    expect(plan.chargeBoundBasis).toMatch(/context window/)
    expect(plan.estimateNotABoundUsd).toBeLessThan(plan.chargeBoundUsd)
    expect(plan.withinBound).toBe(true)
    expect((await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, model: 'claude-sonnet-5-5', maxUsd: 0.2 })).withinBound).toBe(false)
    expect(requestChargeBoundUsd({ ...plan.request, model: 'claude-unknown' })).toBeNull()
  })
  it('refuses a cap that is not a finite positive number', async () => {
    for (const maxUsd of [NaN, Infinity, 0, -1, '5']) {
      await expect(planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, model: 'claude-sonnet-5-5', maxUsd })).rejects.toThrow(/finite positive/)
    }
  })
  it('accepts exactly one case id and one record', async () => {
    await expect(planSinglePaper({ caseId: 'CAR-10,CAR-11', pmid: '1', pmcXml: SYNTH })).rejects.toThrow(/One case id/)
    await expect(planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: '<x/>' })).rejects.toThrow(/no <body>/)
  })
})

describe('fake run and comparison', () => {
  it('verifies the fake extraction against the full corpus and labels it fake', async () => {
    const plan = await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH })
    const run = await runSinglePaper(plan, async () => FAKE, { label: 'fake' })
    expect(run.note).toMatch(/FAKE PROVIDER/)
    expect(run.rows[0].tier).toBe('verified-estimate')
    expect(run.rows[0].explanation.unchecked.join(' ')).toMatch(/Endpoint/)
    await expect(runSinglePaper(plan, null, { label: 'fake' })).rejects.toThrow(/provider/)
  })
  // Codex R2 P2: numbers alone were reported as a "found" reference match.
  it('lists numeric candidates for review and never scores them, even against an adjudicated reference', async () => {
    const plan = await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH })
    const run = await runSinglePaper(plan, async () => FAKE, { label: 'fake' })
    for (const ref of [REFERENCE, { ...REFERENCE, adjudicationStatus: 'draft' }]) {
      const cmp = compareToReference(run, ref)
      expect(cmp).toMatchObject({ scored: false, status: 'numeric-candidates-pending-review' })
      expect(JSON.stringify(cmp)).not.toMatch(/"found"|"omitted"|"arms-swapped"/)
    }
    const byId = Object.fromEntries(compareToReference(run, REFERENCE).items.map((i) => [i.id, i]))
    expect(byId.primary.candidates).toHaveLength(1)
    expect(byId.primary.candidates[0].numbers).toEqual({ value: 'match', ci: 'match', p: 'match', reversed: false })
    expect(byId.mi.candidates[0].numbers.reversed).toBe(true)
    expect(byId.mi.candidates[0].numbers.p).toBe('missing')
    expect(byId['stroke-or-death'].candidates).toEqual([])
    expect(byId['clinical-weight'].candidates).toEqual([])
    expect(byId.primary.candidates[0].review).toEqual({ endpoint: null, population: null, timepoint: null, arms: null, pBinding: null, reviewer: null })
  })
  it('a wrong-endpoint row with the right numbers is a candidate, not a match; a missing P is reported', () => {
    const run = { rows: [{ quantity: { name: 'Wrong endpoint in wrong population at wrong time', value: 1.11, ci_low: 0.81, ci_high: 1.51, p_value: null }, tier: 'verified-estimate' }] }
    const cmp = compareToReference(run, REFERENCE)
    const primary = cmp.items.find((i) => i.id === 'primary')
    expect(cmp.scored).toBe(false)
    expect(primary.candidates[0]).toMatchObject({ extractedName: 'Wrong endpoint in wrong population at wrong time', numbers: { p: 'missing' } })
    expect(primary.candidates[0].review.endpoint).toBeNull()
  })
  it('the same numbers under different endpoints are all listed, none consumed', () => {
    const row = (name, p) => ({ quantity: { name, value: 1.11, ci_low: 0.81, ci_high: 1.51, p_value: p }, tier: 'verified-estimate' })
    const run = { rows: [row('Primary composite', 0.51), row('Stroke at 30 days', 0.04), row('Death in women', 0.51)] }
    const primary = compareToReference(run, REFERENCE).items.find((i) => i.id === 'primary')
    expect(primary.candidates.map((c) => [c.extractedName, c.numbers.p])).toEqual([['Primary composite', 'match'], ['Stroke at 30 days', 'mismatch'], ['Death in women', 'match']])
  })
})

describe('CLI gates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verastar-eval-'))
  const xml = join(dir, 'synthetic.xml')
  const fake = join(dir, 'fake.json')
  const ref = join(dir, 'ref.json')
  writeFileSync(xml, SYNTH)
  writeFileSync(fake, JSON.stringify(FAKE))
  writeFileSync(ref, JSON.stringify(REFERENCE))
  const quiet = () => {}

  it('defaults to a dry-run with no provider', async () => {
    const report = await main(['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', xml], {}, quiet)
    expect(report.mode).toBe('dry-run')
    expect(report.run).toBeUndefined()
    expect(report.plan.source).toBeUndefined() // the paper's text is not echoed into reports
  })
  it('runs the fake provider and compares when asked, writing outside the repo', async () => {
    const out = join(dir, 'out')
    const report = await main(['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', xml, '--fake', fake, '--reference', ref, '--out', out], {}, quiet)
    expect(report.mode).toBe('fake')
    expect(JSON.parse(readFileSync(join(out, 'CAR-10.fake.json'), 'utf8')).comparison.status).toBe('numeric-candidates-pending-review')
  })
  it('refuses folders, extra paths and an output inside the public repo', async () => {
    await expect(main(['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', dir], {}, quiet)).rejects.toThrow(/one file/)
    expect(() => parseArgs(['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', xml, 'second.xml'])).toThrow(/one paper/)
    await expect(main(['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', xml, '--out', 'tmp-eval'], {}, quiet)).rejects.toThrow(/outside the public app repo/)
  })
  it('refuses live without a model, a valid cap covering the conservative bound, an --out and the operator guard', async () => {
    const base = ['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', xml, '--live']
    await expect(main(base, {}, quiet)).rejects.toThrow(/--model is required[\s\S]*--max-usd is required[\s\S]*--out is required[\s\S]*VERASTAR_EVAL_AUTHORIZE/)
    // $0.20 covered the old byte "bound"; it does not cover the context-window bound.
    await expect(main([...base, '--model', 'claude-sonnet-5-5', '--max-usd', '0.2'], {}, quiet)).rejects.toThrow(/conservative charge bound \$2\.0819 exceeds --max-usd 0\.2/)
    await expect(main([...base, '--model', 'claude-unknown', '--max-usd', '5'], {}, quiet)).rejects.toThrow(/has no price/)
    for (const bad of ['abc', 'Infinity', '0', '-1']) {
      await expect(main([...base, '--model', 'claude-sonnet-5-5', '--max-usd', bad], {}, quiet)).rejects.toThrow(/finite positive/)
    }
    const plan = await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, model: 'claude-sonnet-5-5', maxUsd: 5 })
    expect(liveGate(plan, { model: 'claude-sonnet-5-5', maxUsd: 5, out: dir, env: { VERASTAR_EVAL_AUTHORIZE: 'CAR-10:wrong' } })).toHaveLength(1)
    // The gate passes only with every condition; this test never constructs a live client.
    expect(liveGate(plan, { model: 'claude-sonnet-5-5', maxUsd: 5, out: dir, env: { VERASTAR_EVAL_AUTHORIZE: authorizationFor(plan) } })).toEqual([])
  })
  it('never imports the store or the evidence cache', () => {
    for (const file of ['singlePaper.js', '../../scripts/eval-single-paper.mjs']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(src).not.toMatch(/lib\/store|evidenceCache|storeSupabase/)
    }
  })
})

// Codex R2 P1: the live client kept the SDK's default 2 retries, so one "attempt" could be
// three requests. The adapter is tested here with a FAKE transport (an injected fetch);
// no request leaves the machine and no live test is authorized.
describe('live adapter — one attempt, receipts, fake transport only', () => {
  const REQUEST = { model: 'claude-sonnet-5-5', maxTokens: 64, system: 's', content: 'c', schema: { type: 'object' }, thinking: { type: 'disabled' } }
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_fake_1', 'retry-after': '0', ...headers } })
  const errorBody = (type) => ({ type: 'error', error: { type, message: type } })
  const harness = (respond, opts = {}) => {
    const calls = []
    const receipts = []
    const fetch = async (url, init) => {
      calls.push({ url: String(url), receiptsSoFar: receipts.length })
      return respond(init)
    }
    const provider = makeLiveProvider({ apiKey: 'test-key', fetch, Anthropic, onReceipt: async (r) => { receipts.push(r) }, context: { caseId: 'CAR-10', sourceSha256: 'abc' }, ...opts })
    return { provider, calls, receipts }
  }

  it('pins the SDK default that caused the finding: without maxRetries one call is three requests', async () => {
    let n = 0
    const client = new Anthropic({ apiKey: 'test-key', fetch: async () => { n++; return json(429, errorBody('rate_limit_error')) } })
    await expect(client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow()
    expect(n).toBe(3)
  })
  for (const [status, type, outcome] of [[408, 'timeout_error', 'ambiguous'], [429, 'rate_limit_error', 'rejected'], [529, 'overloaded_error', 'ambiguous']]) {
    it(`HTTP ${status}: exactly one request, receipt records ${outcome}`, async () => {
      const { provider, calls, receipts } = harness(() => json(status, errorBody(type)))
      await expect(provider(REQUEST)).rejects.toThrow()
      expect(calls).toHaveLength(1)
      expect(receipts.map((r) => r.status)).toEqual(['dispatching', 'failed'])
      expect(receipts[1]).toMatchObject({ outcome, maxRetries: 0, error: { status }, requestId: 'req_fake_1', caseId: 'CAR-10' })
    })
  }
  it('timeout: exactly one request, recorded as ambiguous', async () => {
    const { provider, calls, receipts } = harness((init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }), { timeoutMs: 25 })
    await expect(provider(REQUEST)).rejects.toThrow()
    expect(calls).toHaveLength(1)
    expect(receipts[1]).toMatchObject({ status: 'failed', outcome: 'ambiguous', timeoutMs: 25, error: { name: 'APIConnectionTimeoutError', status: null } })
  })
  it('connection failure: exactly one request, recorded as ambiguous', async () => {
    const { provider, calls, receipts } = harness(() => { throw new TypeError('fetch failed') })
    await expect(provider(REQUEST)).rejects.toThrow()
    expect(calls).toHaveLength(1)
    expect(receipts[1]).toMatchObject({ status: 'failed', outcome: 'ambiguous', error: { name: 'APIConnectionError', status: null } })
  })
  it('success: the receipt is persisted before dispatch, then carries request id, usage, charge and latency', async () => {
    let t = 1000
    const usage = { input_tokens: 1000, output_tokens: 200 }
    const { provider, calls, receipts } = harness(() => json(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{"quantities":[]}' }], stop_reason: 'end_turn', usage }), { now: () => (t += 50) })
    expect(await provider(REQUEST)).toEqual({ quantities: [] })
    expect(calls[0].receiptsSoFar).toBe(1) // written before the request left
    expect(receipts[0]).toMatchObject({ status: 'dispatching', maxRetries: 0, timeoutMs: LIVE_TIMEOUT_MS, model: 'claude-sonnet-5-5' })
    expect(receipts[0].requestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(receipts[1]).toMatchObject({ status: 'completed', requestId: 'req_fake_1', usage, responseModel: 'claude-sonnet-5-5', latencyMs: 50 })
    expect(receipts[1].chargeUsd).toBeCloseTo((1000 * 2 + 200 * 10) / 1e6, 9)
  })
  it('an unusable response keeps its usage and charge in the receipt', async () => {
    const usage = { input_tokens: 10, output_tokens: 64 }
    const { provider, receipts } = harness(() => json(200, { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{"quan' }], stop_reason: 'max_tokens', usage }))
    await expect(provider(REQUEST)).rejects.toThrow(/incomplete/)
    expect(receipts[1]).toMatchObject({ status: 'response-unusable', usage, requestId: 'req_fake_1' })
    expect(receipts[1].chargeUsd).toBeGreaterThan(0)
  })
  it('refuses to build without an explicit positive timeout', () => {
    expect(() => makeLiveProvider({ timeoutMs: 0 })).toThrow(/timeout/)
  })
})

// Haiku 5.5 is an evaluation-only model (src/eval/evalModels.js). Everything below runs on
// the synthetic record with a fake transport; no request leaves the machine.
describe('Haiku 5.5 — evaluation-only model', () => {
  const HAIKU = 'claude-haiku-5-5'
  const sha = (text) => createHash('sha256').update(text).digest('hex')
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_fake_h', 'retry-after': '0' } })
  const message = (over = {}) => ({ id: 'msg_h', type: 'message', role: 'assistant', model: HAIKU, content: [{ type: 'text', text: JSON.stringify(FAKE) }], stop_reason: 'end_turn', usage: { input_tokens: 11481, output_tokens: 2321, service_tier: 'standard', inference_geo: 'global' }, ...over })
  const harness = (respond, opts = {}) => {
    const calls = []
    const receipts = []
    const fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: Object.fromEntries(new Headers(init.headers)), receiptsSoFar: receipts.length })
      return respond(init)
    }
    const provider = makeLiveProvider({ apiKey: 'test-key', fetch, Anthropic, onReceipt: async (r) => { receipts.push(r) }, context: { caseId: 'CAR-10' }, ...opts })
    return { provider, calls, receipts }
  }
  const plan = (over = {}) => planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, model: HAIKU, maxUsd: 0.53, ...over })

  it('plans the same source, prompt, schema, framing and output limit as the Sonnet request', async () => {
    const haiku = await plan()
    const sonnet = await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, model: 'claude-sonnet-5-5', maxUsd: 5 })
    for (const key of ['system', 'content', 'schema', 'maxTokens', 'thinking']) expect(haiku.request[key]).toEqual(sonnet.request[key])
    expect(haiku.request.system).toBe(EXTRACTION_SYSTEM)
    expect(haiku.request.schema).toBe(EXTRACTION_SCHEMA)
    expect(haiku.request.maxTokens).toBe(EXTRACTION_MAX_TOKENS)
    expect(haiku.request.maxTokens).toBe(8192)
    for (const key of ['sourceSha256', 'extractionInputSha256', 'extractionVersion', 'verificationVersion']) expect(haiku[key]).toBe(sonnet[key])
    for (const key of ['systemSha256', 'schemaSha256', 'contentSha256', 'maxTokens', 'outputFormat']) expect(haiku.requestSettings[key]).toBe(sonnet.requestSettings[key])
    expect(haiku.requestSettings.systemSha256).toBe(sha(EXTRACTION_SYSTEM))
    expect(haiku.requestSettings.schemaSha256).toBe(sha(JSON.stringify(EXTRACTION_SCHEMA)))
    expect(haiku.requestSettings.requestSha256).not.toBe(sonnet.requestSettings.requestSha256)
  })
  it('records the thinking and effort difference instead of claiming parity', async () => {
    expect((await plan()).requestSettings).toMatchObject({ thinkingRequested: { type: 'disabled' }, thinkingSent: { type: 'disabled' }, effortSent: null, effectiveEffort: 'medium', thinkingDisabledSupported: true, cacheControl: false, tools: false, betas: [], samplingParameters: false })
    const sonnet = await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, model: 'claude-sonnet-5-5' })
    expect(sonnet.requestSettings).toMatchObject({ thinkingRequested: { type: 'disabled' }, thinkingSent: { type: 'between_tools' }, effortSent: null, effectiveEffort: 'high' })
  })
  it('bounds the request at exactly $0.520480, from the eval-only table', async () => {
    const p = await plan()
    expect(p.chargeBoundUsd).toBe(0.52048)
    expect(requestChargeBoundUsd(p.request)).toBe(0.52048)
    expect(p.chargeBoundBasis).toMatch(/over-100000-token prompt list price \(eval-only table\)/)
    expect(p.priceTable).toMatch(/^eval-only/)
    expect(p.withinBound).toBe(true)
    // The byte figure is a labelled estimate at the short-prompt rate; it never gates.
    expect(p.estimateNotABoundUsd).toBeLessThan(0.01)
    expect((await plan({ maxUsd: 0.52 })).withinBound).toBe(false)
    expect((await planSinglePaper({ caseId: 'CAR-10', pmid: '1', pmcXml: SYNTH, model: 'claude-sonnet-5-5' })).priceTable).toMatch(/^shared/)
  })
  it('the live gate needs a cap that covers the bound, and still every other condition', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verastar-eval-haiku-'))
    const xml = join(dir, 'synthetic.xml')
    writeFileSync(xml, SYNTH)
    const base = ['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', xml, '--live', '--model', HAIKU]
    await expect(main([...base, '--max-usd', '0.52', '--out', dir], {}, () => {})).rejects.toThrow(/conservative charge bound \$0\.5205 exceeds --max-usd 0\.52[\s\S]*VERASTAR_EVAL_AUTHORIZE/)
    await expect(main([...base, '--max-usd', '0.53'], {}, () => {})).rejects.toThrow(/--out is required[\s\S]*VERASTAR_EVAL_AUTHORIZE/)
    for (const bad of ['abc', 'Infinity', '0', '-1', 'NaN']) {
      await expect(main([...base, '--max-usd', bad, '--out', dir], {}, () => {})).rejects.toThrow(/finite positive/)
    }
    for (const model of ['claude-haiku-5-5-20261007', 'claude-haiku-5', 'claude-opus-5-5']) {
      await expect(main(['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', xml, '--live', '--model', model, '--max-usd', '5', '--out', dir], {}, () => {})).rejects.toThrow(/has no price in the shared or eval-only price table/)
    }
    const p = await plan()
    expect(liveGate(p, { model: HAIKU, maxUsd: 0.53, out: dir, env: {} })).toHaveLength(1)
    expect(liveGate(p, { model: HAIKU, maxUsd: 0.53, out: dir, env: { VERASTAR_EVAL_AUTHORIZE: authorizationFor(p) } })).toEqual([])
    // The dry-run writes hashes and settings, never the paper's text.
    const out = join(dir, 'out')
    const report = await main(['--case', 'CAR-10', '--pmid', '1', '--pmc-xml', xml, '--model', HAIKU, '--max-usd', '0.53', '--out', out], {}, () => {})
    expect(report.mode).toBe('dry-run')
    expect(report.plan).toMatchObject({ model: HAIKU, chargeBoundUsd: 0.52048, withinBound: true, request: { model: HAIKU, maxTokens: 8192, thinking: { type: 'disabled' } } })
    expect(readFileSync(join(out, 'CAR-10.dry-run.json'), 'utf8')).not.toContain('Myocardial infarction occurred')
  })
  it('sends exactly one SDK request with the Haiku body, after the receipt is written', async () => {
    const p = await plan()
    const { provider, calls, receipts } = harness(() => json(200, message()))
    const run = await runSinglePaper(p, provider, { label: 'live' })
    expect(calls).toHaveLength(1)
    expect(calls[0].receiptsSoFar).toBe(1)
    expect(calls[0].url).toMatch(/\/v1\/messages$/)
    expect(calls[0].body).toEqual({
      model: HAIKU,
      max_tokens: 8192,
      system: EXTRACTION_SYSTEM,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: p.request.content }],
      output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    })
    expect(calls[0].body).toEqual(liveRequestBody(p.request))
    expect(calls[0].headers['anthropic-beta']).toBeUndefined()
    expect(receipts[0]).toMatchObject({ status: 'dispatching', model: HAIKU, maxRetries: 0, timeoutMs: 300_000, requestSha256: p.requestSettings.requestSha256 })
    expect(receipts[0].requestSha256).toBe(sha(JSON.stringify(calls[0].body)))
    expect(receipts[0].requestSettings).toEqual(await requestSettings(p.request))
    expect(JSON.stringify(receipts)).not.toContain('test-key')
    expect(receipts[1]).toMatchObject({ status: 'completed', responseModel: HAIKU, responseModelMatches: true, requestId: 'req_fake_h', chargePromptTier: 'standard', chargePromptTokens: 11481 })
    expect(receipts[1].chargeUsd).toBe(Math.ceil((11481 * 100_000 + 2321 * 500_000) / 1e6) / 1e6)
    expect(run.rows).toHaveLength(FAKE.quantities.length)
  })
  it('settles a long prompt at the higher rate for every category', async () => {
    const usage = { input_tokens: 60_000, cache_read_input_tokens: 40_001, output_tokens: 1000 }
    const { provider, receipts } = harness(() => json(200, message({ usage })))
    await provider((await plan()).request)
    expect(receipts[1]).toMatchObject({ status: 'completed', chargePromptTier: 'long', chargePromptTokens: 100_001 })
    expect(receipts[1].chargeUsd).toBe(Math.ceil((60_000 * 500_000 + 40_001 * 50_000 + 1000 * 2_500_000) / 1e6) / 1e6)
  })
  it('a response naming another model is not priced as Haiku and is not a comparison', async () => {
    for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-haiku-5-5-20261007', undefined]) {
      const { provider, calls, receipts } = harness(() => json(200, message({ model })))
      await expect(runSinglePaper(await plan(), provider, { label: 'live' })).rejects.toThrow(/Not a valid comparison/)
      expect(calls).toHaveLength(1)
      expect(receipts[1]).toMatchObject({ status: 'response-model-mismatch', responseModelMatches: false, chargeUsd: null, chargeUnpricedReason: 'response_model_mismatch', usage: { input_tokens: 11481, output_tokens: 2321 }, requestId: 'req_fake_h' })
      expect(receipts[1].responseModel).toBe(model ?? null)
    }
  })
  it('usage this table cannot price stays unpriced, never zero', async () => {
    const cases = [
      [{ input_tokens: 10 }, 'malformed_usage'],
      [{ input_tokens: -1, output_tokens: 5 }, 'malformed_usage'],
      [{ input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 2 } }, 'server_tool_use'],
      [{ input_tokens: 10, output_tokens: 5, service_tier: 'priority' }, 'service_tier'],
      [{ input_tokens: 10, output_tokens: 5, inference_geo: 'us' }, 'inference_geo'],
      [undefined, 'missing_usage'],
    ]
    for (const [usage, reason] of cases) {
      const { provider, receipts } = harness(() => json(200, message({ usage })))
      await provider((await plan()).request)
      expect(receipts[1]).toMatchObject({ status: 'completed', chargeUsd: null, chargeUnpricedReason: reason })
    }
  })
  for (const [status, type, outcome] of [[400, 'invalid_request_error', 'rejected'], [429, 'rate_limit_error', 'rejected'], [500, 'api_error', 'ambiguous'], [529, 'overloaded_error', 'ambiguous']]) {
    it(`HTTP ${status}: one request, no retry, receipt records ${outcome} with no charge`, async () => {
      const { provider, calls, receipts } = harness(() => json(status, { type: 'error', error: { type, message: type } }))
      await expect(provider((await plan()).request)).rejects.toThrow()
      expect(calls).toHaveLength(1)
      expect(receipts.map((r) => r.status)).toEqual(['dispatching', 'failed'])
      expect(receipts[1]).toMatchObject({ outcome, model: HAIKU, maxRetries: 0, error: { status } })
      expect(receipts[1].chargeUsd).toBeUndefined()
    })
  }
  it('a timeout is one request and ambiguous', async () => {
    const { provider, calls, receipts } = harness((init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }), { timeoutMs: 25 })
    await expect(provider((await plan()).request)).rejects.toThrow()
    expect(calls).toHaveLength(1)
    expect(receipts[1]).toMatchObject({ status: 'failed', outcome: 'ambiguous', timeoutMs: 25 })
  })
  it('keeps the parsed extraction before label post-processing, distinct from the rows', async () => {
    const raw = { study_id: '1', design: 'RCT', quantities: [{ ...FAKE.quantities[0], quantity_type: 'comparison', value: null, first_label: 'an arm the quote never prints', first_value: FAKE.quantities[0].value ?? 1, second_label: 'another unprinted arm', second_value: 2 }] }
    const run = await runSinglePaper(await plan(), async () => raw, { label: 'fake' })
    expect(run.rawExtraction).toEqual(raw)
    expect(run.rawExtraction.quantities[0].first_label).toBe('an arm the quote never prints')
    expect(run.rows[0].quantity.first_label).toBeNull()
    expect(run.rows[0].quantity.second_label).toBeNull()
  })
})

describe('the Sonnet request is unchanged by eval-only support', () => {
  it('builds the body the v2 harness built, key for key', async () => {
    const request = { model: 'claude-sonnet-5-5', maxTokens: 8192, system: 's', content: 'c', schema: { type: 'object' }, thinking: { type: 'disabled' } }
    expect(JSON.stringify(liveRequestBody(request))).toBe('{"model":"claude-sonnet-5-5","max_tokens":8192,"system":"s","thinking":{"type":"between_tools"},"messages":[{"role":"user","content":"c"}],"output_config":{"format":{"type":"json_schema","schema":{"type":"object"}}}}')
    expect(liveRequestBody({ ...request, thinking: undefined }).thinking).toBeUndefined()
  })
  it('a Sonnet response naming another model is refused too', async () => {
    const receipts = []
    const fetch = async () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: '{"quantities":[]}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    const provider = makeLiveProvider({ apiKey: 'test-key', fetch, Anthropic, onReceipt: async (r) => { receipts.push(r) } })
    await expect(provider({ model: 'claude-sonnet-5-5', maxTokens: 64, system: 's', content: 'c', schema: { type: 'object' }, thinking: { type: 'disabled' } })).rejects.toThrow(/Not a valid comparison/)
    expect(receipts[1]).toMatchObject({ status: 'response-model-mismatch', chargeUsd: null })
  })
})
