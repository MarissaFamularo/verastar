// summaryEval.test.js — the summary evaluation harness: the ledger refuses a request whose
// conservative bound would cross the cap, every call is traced and priced, a frozen case
// runs end to end on the fake client, and the probes report the deterministic and model
// verdicts separately. No network.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureServerClient } from '../lib/anthropic.js'
import { makeLedger, wrapClient, fakeClient, installClient, requestBoundUsd, loadFrozenCase, runSummary, runProbes, summarizeProbes, FROZEN_CASES, EXCLUDED_CASES, CapReached, candidateFor } from './summaryEval.js'

const dirs = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'summary-eval-')); dirs.push(d); return d }
afterEach(() => { configureServerClient({}); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('spend ledger', () => {
  it('bounds a request as whole input plus max_tokens and refuses to dispatch past the cap', async () => {
    const dir = tmp()
    const ledger = makeLedger({ capUsd: 0.05, dir, label: 't' })
    const body = { model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: 'x'.repeat(4000) }] }
    expect(requestBoundUsd(body)).toBeGreaterThan(0.02)
    const context = { caseId: 'c', purpose: 'p' }
    const client = wrapClient(fakeClient(), { ledger, traceDir: dir, context })
    await client.messages.create({ ...body, output_config: { format: { type: 'json_schema', schema: { properties: { obligations: {} } } } } })
    expect(ledger.total).toBeGreaterThan(0)
    expect(ledger.state.calls).toBe(1)
    await expect(client.messages.create({ ...body, max_tokens: 60000 })).rejects.toBeInstanceOf(CapReached)
    expect(ledger.state.calls).toBe(1) // refused before dispatch, nothing recorded
    const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ caseId: 'c', purpose: 'p', model: body.model, usage: { input_tokens: 1000, output_tokens: 200 } })
    expect(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).totalUsd).toBe(ledger.total)
    const calls = readdirSync(join(dir, 'calls'))
    expect(calls).toHaveLength(1)
    const trace = JSON.parse(readFileSync(join(dir, 'calls', calls[0]), 'utf8'))
    expect(trace).toMatchObject({ caseId: 'c', purpose: 'p', model: body.model, stopReason: 'end_turn' })
    expect(trace.requestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(trace.request.messages[0].content).toBe(body.messages[0].content)
  })
  it('charges the conservative bound as a liability for an ambiguous failure after dispatch, and nothing for a provider rejection', async () => {
    const dir = tmp()
    const context = { caseId: 'c', purpose: 'p' }
    const body = { model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: 'x'.repeat(4000) }] }
    const bound = requestBoundUsd(body)
    const ledger = makeLedger({ capUsd: 2.5 * bound, dir }) // room for two bounds, not three
    const failing = (status) => wrapClient({ messages: { create: async () => { const e = new Error('boom'); e.status = status; e.name = status ? 'APIError' : 'APIConnectionTimeoutError'; throw e } } }, { ledger, traceDir: dir, context })
    await expect(failing(undefined).messages.create(body)).rejects.toThrow('boom') // timeout: ambiguous
    expect(ledger.total).toBe(Number(bound.toFixed(6)))
    expect(ledger.state).toMatchObject({ calls: 1, unpricedCalls: 1, liabilityUsd: Number(bound.toFixed(6)) })
    await expect(failing(400).messages.create(body)).rejects.toThrow('boom') // refused before processing: $0
    expect(ledger.total).toBe(Number(bound.toFixed(6)))
    await expect(failing(529).messages.create(body)).rejects.toThrow('boom') // overloaded: ambiguous
    expect(ledger.total).toBe(Number((2 * bound).toFixed(6)))
    expect(ledger.state.calls).toBe(3)
    const entries = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(entries.map((e) => [e.outcome, e.liability, e.chargedUsd > 0])).toEqual([['ambiguous', true, true], ['rejected', false, false], ['ambiguous', true, true]])
    // The liabilities count against the cap: the next request is refused before dispatch.
    await expect(failing(undefined).messages.create(body)).rejects.toBeInstanceOf(CapReached)
    expect(ledger.state.calls).toBe(3)
  })
  it('charges the bound for a response the table cannot price or that names another model', async () => {
    const dir = tmp()
    const ledger = makeLedger({ capUsd: 1, dir })
    const context = { caseId: 'c', purpose: 'p' }
    const body = { model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: 'x'.repeat(4000) }] }
    const bound = Number(requestBoundUsd(body).toFixed(6))
    const msg = (usage, model = body.model) => ({ id: 'm', model, content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage })
    const respond = (res) => wrapClient({ messages: { create: async () => res } }, { ledger, traceDir: dir, context })
    await respond(msg({ input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 1 } })).messages.create(body)
    expect(ledger.total).toBe(bound)
    await respond(msg(undefined)).messages.create(body)
    expect(ledger.total).toBe(Number((2 * bound).toFixed(6)))
    await respond(msg({ input_tokens: 10, output_tokens: 10 }, 'claude-sonnet-5-5')).messages.create(body)
    expect(ledger.total).toBe(Number((3 * bound).toFixed(6)))
    await respond(msg({ input_tokens: 10, output_tokens: 10 })).messages.create(body) // priceable: actual usage, far below the bound
    expect(ledger.total).toBeLessThan(Number((4 * bound).toFixed(6)))
    expect(ledger.state).toMatchObject({ calls: 4, unpricedCalls: 3 })
    const last = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(last.map((e) => e.unpricedReason)).toEqual(['server_tool_use', 'missing_usage', 'response_model_mismatch', null])
  })
  it('refuses an unpriced model before dispatch', () => {
    const ledger = makeLedger({ capUsd: 1, dir: tmp() })
    expect(() => ledger.assertRoom({ model: 'claude-opus-9', max_tokens: 10 })).toThrow(/not in the shared price table/)
  })
})

describe('frozen cases', () => {
  it('lists six distinct papers, excludes TEVAR with its reason, and loads every archived case with current verdicts', () => {
    expect(FROZEN_CASES.map((c) => c.pmid)).toEqual(['42513277', '42769537', '42573020', '42637117', '42681580', '42600759'])
    expect(new Set(FROZEN_CASES.map((c) => c.pmid)).size).toBe(6)
    expect(EXCLUDED_CASES[0]).toMatchObject({ id: 'TEVAR', pmid: '42693683' })
    const parade = loadFrozenCase(FROZEN_CASES[0])
    expect(parade.needsExtraction).toBe(false)
    expect(parade.result.evidenceSource.sections.length).toBeGreaterThan(0)
    // v14 admits PARADE's "95% CI of 1.04–1.61": the conventional Cox survival tuple verifies.
    expect(parade.result.rows[1].verdict.relationshipValidated).toBe(true)
    const carotid = loadFrozenCase(FROZEN_CASES[3])
    expect(carotid.needsExtraction).toBe(true)
    expect(carotid.result.sourceDoc.text).toMatch(/radiation-induced carotid artery stenosis/i)
  })
  it('runs a frozen case end to end on the fake client and writes complete traces', async () => {
    const dir = tmp()
    const ledger = makeLedger({ capUsd: 5, dir })
    const context = { caseId: null, purpose: null }
    installClient(fakeClient({ findingFor: () => 'Fake number-free finding.' }), { ledger, traceDir: dir, context })
    const loaded = loadFrozenCase(FROZEN_CASES[2]) // balloon
    const out = await runSummary({ loaded, checkerModel: 'claude-haiku-4-5-20251001', traceDir: dir, context })
    expect(out.take).toMatchObject({ summaryKind: 'validated', finding: 'Fake number-free finding.' })
    const files = readdirSync(join(dir, 'papers', 'BALLOON'))
    expect(files).toEqual(expect.arrayContaining(['candidate.json', 'input.json', 'evidence.txt', 'take.json']))
    expect(files.some((f) => /\.writer\.json$/.test(f))).toBe(true)
    expect(files.some((f) => /\.check\.json$/.test(f))).toBe(true)
    const input = JSON.parse(readFileSync(join(dir, 'papers', 'BALLOON', 'input.json'), 'utf8'))
    expect(input.audit).toMatchObject({ spans: 39, located: 39 })
    expect(input.source.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(ledger.state.calls).toBe(2) // one writer batch, one check
    expect(existsSync(join(dir, 'calls'))).toBe(true)
  })
  it('two checker-model runs into one output directory keep both sets of traces when each run has its own trace directory', async () => {
    const out = tmp()
    const ledger = makeLedger({ capUsd: 5, dir: out }) // one ledger at the output root
    const loaded = loadFrozenCase(FROZEN_CASES[2])
    const runs = []
    for (const checkerModel of ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5']) {
      const traceDir = join(out, 'runs', `dev-${checkerModel}`)
      const context = { caseId: null, purpose: null }
      installClient(fakeClient(), { ledger, traceDir, context })
      runs.push({ traceDir, out: await runSummary({ loaded, checkerModel, traceDir, context }) })
    }
    for (const run of runs) {
      const take = JSON.parse(readFileSync(join(run.traceDir, 'papers', 'BALLOON', 'take.json'), 'utf8'))
      expect(take.checkerModel).toBe(run.out.checkerModel)
      expect(readdirSync(join(run.traceDir, 'calls'))).toHaveLength(2)
    }
    expect(ledger.state.calls).toBe(4)
    expect(existsSync(join(out, 'papers'))).toBe(false)
  })
  it('builds the candidate the way the digest does: complete evidence, handoff, located primary, verified rows', () => {
    const loaded = loadFrozenCase(FROZEN_CASES[1]) // aspirin
    const c = candidateFor(loaded.result)
    expect(c.evidence).toMatch(/^\[Evidence window: complete abstract and complete Results sections of the full text\]/)
    expect(c.resultHandoff.audit.located).toBe(64)
    expect(c.verified.length).toBeGreaterThan(0)
  })
})

describe('checker probes', () => {
  it('reports deterministic and model verdicts separately for every probe and repeat', async () => {
    const dir = tmp()
    const context = { caseId: null, purpose: null }
    installClient(fakeClient(), { ledger: makeLedger({ capUsd: 5, dir }), traceDir: dir, context })
    const results = await runProbes({ checkerModel: 'claude-haiku-4-5-20251001', repeats: 2, traceDir: dir, context })
    expect(results).toHaveLength(10)
    const summary = summarizeProbes(results)
    expect(summary['correct-control']).toMatchObject({ runs: 2, deterministicCorrect: 2 })
    for (const id of ['outcome-swap', 'comparator-reversal', 'analysis-substitution', 'borrowed-ci']) expect(summary[id].deterministicCorrect).toBe(2)
    // The fake checker accepts everything: that shows as model failures, never as a pass.
    expect(summary['outcome-swap'].modelCorrect).toBe(0)
  })
})
