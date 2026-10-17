// The paid-request policy (supabase/functions/_shared/requestPolicy.js). The first block
// captures the EXACT bodies the app's own call sites send through the real Anthropic SDK
// and proves each is admitted, so tightening the policy cannot silently break extraction,
// triage, the prose check or ping.
import { describe, it, expect, afterEach } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { configureServerClient, ping, MODELS, setApiKey, clearApiKey } from './anthropic.js'
import { extractQuantities, EXTRACTION_RETRY_MAX_TOKENS } from '../pipeline/extract.js'
import { checkFindings } from '../pipeline/check.js'
import { triage, triageMaxTokens } from '../pipeline/triage.js'
import {
  checkPaidRequest, readBoundedText, requestFingerprint,
  MAX_BODY_BYTES, MAX_OUTPUT_TOKENS, MAX_MESSAGES, MAX_SCHEMA_BYTES,
} from '../../supabase/functions/_shared/requestPolicy.js'
import { maxChargeMicro, PRICES } from '../../supabase/functions/_shared/pricing.js'

function capturingClient(text = '{}') {
  const bodies = []
  const client = new Anthropic({
    apiKey: 'test',
    maxRetries: 0,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: JSON.parse(init.body).model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  return { client, bodies }
}

afterEach(() => configureServerClient({}))

describe('the app\'s real requests are admitted', () => {
  it('extraction (Sonnet 5.5, between_tools thinking, structured output)', async () => {
    const { client, bodies } = capturingClient('{"study_id":"s","design":"RCT","quantities":[],"result_contexts":[]}')
    configureServerClient({ client })
    await extractQuantities({ studyId: 's', sourceText: 'Mortality was 12% vs 15% (HR 0.80, 95% CI 0.70–0.91).' })
    expect(bodies).toHaveLength(1)
    expect(bodies[0].model).toBe(MODELS.extraction)
    expect(bodies[0].thinking).toEqual({ type: 'between_tools' })
    const r = checkPaidRequest(bodies[0])
    expect(r.ok, r.error).toBe(true)
    expect(r.forward).toEqual(bodies[0])
  })
  it('extraction at the retry output ceiling', async () => {
    const { client, bodies } = capturingClient('{"study_id":"s","design":"RCT","quantities":[],"result_contexts":[]}')
    configureServerClient({ client })
    await extractQuantities({ studyId: 's', sourceText: 'x', maxTokens: EXTRACTION_RETRY_MAX_TOKENS })
    expect(checkPaidRequest(bodies[0]).ok).toBe(true)
  })
  it('triage (Sonnet 5.5, structured output)', async () => {
    const { client, bodies } = capturingClient('{"rankings":[]}')
    configureServerClient({ client })
    const candidates = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: `Paper ${i}`, summary: 'x'.repeat(2600), verified: [] }))
    await triage({ candidates, rubric: 'r' }).catch(() => {})
    expect(bodies[0].max_tokens).toBe(triageMaxTokens(20))
    expect(checkPaidRequest(bodies[0]).ok).toBe(true)
  })
  it('the prose check (Haiku 4.5, no thinking field)', async () => {
    const { client, bodies } = capturingClient('{"verdicts":[]}')
    configureServerClient({ client })
    await checkFindings({ items: [{ id: 1, finding: 'Lower mortality.', snippet: 'Mortality fell.' }] })
    expect(bodies[0].model).toBe(MODELS.fast)
    expect(bodies[0].thinking).toBeUndefined()
    expect(checkPaidRequest(bodies[0]).ok).toBe(true)
  })
  it('ping', async () => {
    const { client, bodies } = capturingClient('pong')
    configureServerClient({ client })
    await ping()
    expect(checkPaidRequest(bodies[0]).ok).toBe(true)
  })
})

const base = () => ({
  model: 'claude-sonnet-5-5',
  max_tokens: 1024,
  system: 'sys',
  thinking: { type: 'between_tools' },
  messages: [{ role: 'user', content: 'hello' }],
  output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: {}, additionalProperties: false } } },
})

describe('rejections', () => {
  const rejects = (mut, re) => {
    const body = base()
    mut(body)
    const r = checkPaidRequest(body)
    expect(r.ok).toBe(false)
    if (re) expect(r.error).toMatch(re)
  }
  it('streaming, at any value', () => {
    rejects((b) => { b.stream = true }, /Streaming/)
    rejects((b) => { b.stream = false }, /Streaming/)
  })
  it('unsupported or prefix-only models', () => {
    for (const m of ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1', 'gpt-4', '', null]) {
      rejects((b) => { b.model = m; delete b.thinking }, /model/)
    }
  })
  it('unknown and extra-charge top-level fields', () => {
    for (const f of ['tools', 'tool_choice', 'metadata', 'service_tier', 'inference_geo', 'speed', 'stop_sequences', 'temperature', 'top_p', 'top_k', 'container', 'mcp_servers', 'cache_control', 'context_management', 'whatever']) {
      rejects((b) => { b[f] = f === 'tools' ? [] : 'x' }, new RegExp(f))
    }
  })
  it('output bounds', () => {
    rejects((b) => { b.max_tokens = 0 })
    rejects((b) => { b.max_tokens = MAX_OUTPUT_TOKENS + 1 })
    rejects((b) => { b.max_tokens = 1024.5 })
    rejects((b) => { b.max_tokens = '1024' })
  })
  it('message count and shape', () => {
    rejects((b) => { b.messages = [] })
    rejects((b) => { b.messages = Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' })) })
    rejects((b) => { b.messages = [{ role: 'system', content: 'x' }] })
    rejects((b) => { b.messages = [{ role: 'user', content: '' }] })
    rejects((b) => { b.messages = [{ role: 'user', content: 'x', name: 'n' }] })
  })
  it('multimodal, documents, tools, citations and cache_control in content', () => {
    rejects((b) => { b.messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] })
    rejects((b) => { b.messages = [{ role: 'user', content: [{ type: 'document', source: { type: 'text', data: 'x' } }] }] })
    rejects((b) => { b.messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] }] })
    rejects((b) => { b.messages = [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }] })
    rejects((b) => { b.messages = [{ role: 'user', content: [{ type: 'text', text: 'x', citations: [] }] }] })
    rejects((b) => { b.system = [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }] })
  })
  it('cache_control smuggled inside the schema', () => {
    rejects((b) => { b.output_config.format.schema.properties.x = { type: 'string', cache_control: { type: 'ephemeral' } } }, /caching/)
  })
  it('thinking modes that are not admitted for the model', () => {
    rejects((b) => { b.thinking = { type: 'enabled', budget_tokens: 2048 } })
    rejects((b) => { b.thinking = { type: 'adaptive' } })
    rejects((b) => { b.thinking = { type: 'between_tools', display: 'omitted' } })
    rejects((b) => { b.thinking = { type: 'disabled' } }) // Sonnet 5.5 rejects disabled
    rejects((b) => { b.model = 'claude-haiku-4-5-20251001'; b.thinking = { type: 'between_tools' } })
  })
  it('output_config beyond a json_schema format', () => {
    rejects((b) => { b.output_config = { effort: 'max' } })
    rejects((b) => { b.output_config.effort = 'high' })
    rejects((b) => { b.output_config = { format: { type: 'text' } } })
    rejects((b) => { b.output_config.format.schema = { type: 'object', description: 'x'.repeat(MAX_SCHEMA_BYTES) } }, /schema is too large/)
  })
  it('a body over the byte ceiling', () => {
    rejects((b) => { b.messages = [{ role: 'user', content: 'x'.repeat(MAX_BODY_BYTES) }] }, /too large/)
  })
})

describe('the context-window ceiling', () => {
  // The ceiling is the documented context window (the API rejects any request whose input
  // alone exceeds it). The amount reserved is smaller: this request's counted input, a
  // safety margin, and max_tokens (tokenReserve.js). bound is the ceiling, not the hold.
  it('caps input at the whole context window and output at max_tokens', () => {
    for (const [model, thinking] of [['claude-sonnet-5-5', { type: 'between_tools' }], ['claude-haiku-4-5-20251001', { type: 'disabled' }]]) {
      const r = checkPaidRequest({ ...base(), model, thinking })
      expect(r.bound.maxInputTokens).toBe(PRICES[model].contextWindowTokens)
      expect(r.bound.maxOutputTokens).toBe(1024)
      expect(r.bound.micro).toBe(maxChargeMicro(model, r.bound))
    }
    expect(checkPaidRequest(base()).bound.micro).toBe(2_000_000 + 10_240)
    expect(checkPaidRequest({ ...base(), model: 'claude-haiku-4-5-20251001', thinking: { type: 'disabled' } }).bound.micro).toBe(200_000 + 5_120)
  })
  it('the ceiling does not depend on the payload: a tiny and a maximal body share it', () => {
    const small = checkPaidRequest(base())
    const big = checkPaidRequest({ ...base(), messages: [{ role: 'user', content: 'x'.repeat(MAX_BODY_BYTES - 600) }] })
    expect(big.ok).toBe(true)
    expect(big.bound).toEqual(small.bound)
  })
  it('largest ceiling: Sonnet 5.5 $2.32, Haiku 4.5 $0.36', () => {
    expect(checkPaidRequest({ ...base(), max_tokens: MAX_OUTPUT_TOKENS }).bound.micro).toBe(2_320_000)
    expect(checkPaidRequest({ ...base(), model: 'claude-haiku-4-5-20251001', thinking: { type: 'disabled' }, max_tokens: MAX_OUTPUT_TOKENS }).bound.micro).toBe(360_000)
  })
  it('the fingerprint binds body and purpose', async () => {
    const a = checkPaidRequest(base()).forwardText
    const b = checkPaidRequest({ ...base(), max_tokens: 1025 }).forwardText
    expect(await requestFingerprint(a, 'x')).toMatch(/^[0-9a-f]{64}$/)
    expect(await requestFingerprint(a, 'x')).toBe(await requestFingerprint(a, 'x'))
    expect(await requestFingerprint(a, 'x')).not.toBe(await requestFingerprint(b, 'x'))
    expect(await requestFingerprint(a, 'x')).not.toBe(await requestFingerprint(a, 'y'))
  })
})

describe('bounded body reads', () => {
  const req = (body, headers = {}) => new Request('https://x/v1/messages', { method: 'POST', body, headers })
  it('rejects a declared oversize body without reading it', async () => {
    expect(await readBoundedText(req('{}', { 'content-length': String(MAX_BODY_BYTES + 1) }))).toMatchObject({ ok: false, status: 413 })
  })
  it('rejects an undeclared oversize stream', async () => {
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(300)); c.close() } })
    const r = new Request('https://x/v1/messages', { method: 'POST', body: big, duplex: 'half' })
    expect(await readBoundedText(r, 1000)).toMatchObject({ ok: false, status: 413 })
  })
  it('rejects invalid UTF-8 and reads a normal body', async () => {
    expect(await readBoundedText(req(new Uint8Array([0xff, 0xfe])))).toMatchObject({ ok: false, status: 400 })
    expect(await readBoundedText(req('{"a":1}'))).toEqual({ ok: true, text: '{"a":1}' })
  })
})

describe('triage through the real SDK (2026-10-09 review: the SDK refused >= 30 candidates)', () => {
  const candidates = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i), title: `Paper ${i}`, summary: 'x'.repeat(200), verified: [] }))
  const rankingReply = (body) => new Response(JSON.stringify({
    id: 'msg_t', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: JSON.stringify({ rankings: [] }) }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  it('pilot guard refuses 30 candidates before the SDK sends', async () => {
    const sent = []
    configureServerClient({ client: new Anthropic({ apiKey: 't', maxRetries: 0, fetch: async (_u, init) => { sent.push(init.body); return rankingReply(JSON.parse(init.body)) } }) })
    await expect(triage({ candidates: candidates(30), rubric: 'r' })).rejects.toThrow(/limited to 20/)
    expect(sent).toHaveLength(0)
  })

  it('the browser\'s BYOK client (real getClient, explicit timeout) sends up to 20 candidates and refuses larger requests', async () => {
    const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } }
    const realFetch = globalThis.fetch
    globalThis.sessionStorage = mem()
    globalThis.localStorage = mem()
    const sent = []
    globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return rankingReply(JSON.parse(init.body)) }
    try {
      setApiKey('sk-test-not-real')
      for (const n of [5, 10, 20]) await triage({ candidates: candidates(n), rubric: 'r' })
      for (const n of [21, 30, 60]) await expect(triage({ candidates: candidates(n) })).rejects.toThrow(/limited to 20/)
      expect(sent.map((b) => b.max_tokens)).toEqual([triageMaxTokens(5), triageMaxTokens(10), triageMaxTokens(20)])
      expect(sent[2].max_tokens).toBe(triageMaxTokens(20))
      for (const b of sent) expect(checkPaidRequest(b).ok).toBe(true)
    } finally {
      clearApiKey()
      globalThis.fetch = realFetch
      delete globalThis.sessionStorage
      delete globalThis.localStorage
    }
  })

  it('the scheduler\'s client (explicit server timeout, guarded fetch) sends 20 candidates through the boundary', async () => {
    const { makeGuardedFetch } = await import('../../supabase/functions/_shared/spending.js')
    const { SERVER_CLIENT_TIMEOUT_MS } = await import('../../supabase/functions/_shared/timeouts.js')
    const { fakeLedger } = await import('./spendingFakes.js')
    const sent = []
    const ledger = fakeLedger()
    const g = makeGuardedFetch({ ledger, userId: 'u', claimToken: 'tok', dispatch: async (text) => { sent.push(JSON.parse(text)); return rankingReply(JSON.parse(text)) } })
    configureServerClient({ client: new Anthropic({ apiKey: 'sponsor-guarded', fetch: g.fetch, maxRetries: 2, timeout: SERVER_CLIENT_TIMEOUT_MS }) })
    await triage({ candidates: candidates(20), rubric: 'r' })
    expect(sent).toHaveLength(1)
    expect(sent[0].max_tokens).toBe(triageMaxTokens(20))
    expect([...ledger.rows.values()][0]).toMatchObject({ state: 'settled', claimToken: 'tok' })
  })
})
