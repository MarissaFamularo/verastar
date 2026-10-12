// The paid-call boundary (supabase/functions/_shared/spending.js) with an in-memory ledger
// and a fake provider. Every case asserts how many times the provider was actually called
// and what liability the ledger still holds. Transactional safety (caps under real
// concurrency) is proven separately against PostgreSQL: supabase/tests/.
import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { guardedProviderCall, makeGuardedFetch, denialResponse, anthropicDispatch, anthropicTokenCounter, countTokensUrl, makeRpcLedger, resolveProviderUrl, ANTHROPIC_URL } from '../../supabase/functions/_shared/spending.js'
import * as T from '../../supabase/functions/_shared/timeouts.js'
import { localInputTokenEstimate, reservationCharge } from '../../supabase/functions/_shared/tokenReserve.js'
import { checkPaidRequest } from '../../supabase/functions/_shared/requestPolicy.js'
import { isCapReached, CapReachedError } from './anthropic.js'
import { fakeLedger, fakeProvider } from './spendingFakes.js'

const MODEL = 'claude-sonnet-5-5'
const body = (extra = {}) => ({ model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], ...extra })

const ok = (usage = { input_tokens: 10, output_tokens: 5 }, model = MODEL) => ({ body: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage } })

const call = (ledger, provider, extra = {}) => guardedProviderCall({ ledger, dispatch: provider.dispatch, userId: 'u1', body: body(), source: 'proxy', purpose: 'test', ...extra })

describe('one paid attempt', () => {
  it('reserves before dispatch, dispatches once, settles the exact cost', async () => {
    const ledger = fakeLedger()
    const provider = fakeProvider(ok())
    const r = await call(ledger, provider)
    expect(provider.sent).toHaveLength(1)
    expect(ledger.calls).toEqual(['reserve', 'settle'])
    expect(r.outcome).toBe('settled')
    expect(r.micro).toBe(70) // 10 x $2 + 5 x $10 per MTok = 70 micro-dollars
    expect(ledger.outstanding()).toBe(0)
    const [row] = ledger.rows.values()
    const checked = checkPaidRequest(body())
    const hold = reservationCharge(MODEL, { rawInputTokens: localInputTokenEstimate(checked.forwardText), maxOutputTokens: 100 })
    expect(row.micro).toBe(hold.micro)
    expect(row.micro).toBeGreaterThan(r.micro) // reconciled down to actual usage
    expect(row.micro).toBeLessThan(20_000) // far below the $2 context-window hold
    expect(checked.bound.micro).toBeGreaterThan(2_000_000)
  })
  it('forwards only the checked request, with only the API headers', async () => {
    const seen = []
    const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response('{}') }
    await anthropicDispatch('sk-test', fetchImpl)('{"a":1}', {})
    expect(seen[0].url).toBe(ANTHROPIC_URL)
    expect(Object.keys(seen[0].init.headers).sort()).toEqual(['anthropic-version', 'content-type', 'x-api-key'])
    const provider = fakeProvider(ok())
    await call(fakeLedger(), provider, { body: { ...body(), thinking: { type: 'between_tools' } } })
    expect(provider.sent[0]).toEqual({ model: MODEL, max_tokens: 100, thinking: { type: 'between_tools' }, messages: [{ role: 'user', content: 'hi' }] })
  })
  it('an invalid request never reserves or dispatches', async () => {
    const ledger = fakeLedger()
    const provider = fakeProvider(ok())
    const r = await call(ledger, provider, { body: body({ tools: [] }) })
    expect(r.response.status).toBe(400)
    expect(ledger.calls).toEqual([])
    expect(provider.sent).toHaveLength(0)
  })
})

describe('accounting failures prevent dispatch', () => {
  it('reserve RPC failure: no dispatch, 503 the SDK will not retry', async () => {
    const provider = fakeProvider(ok())
    const r = await call(fakeLedger({ reserveThrows: true }), provider)
    expect(provider.sent).toHaveLength(0)
    expect(r.response.status).toBe(503)
    expect(r.response.headers['x-should-retry']).toBe('false')
  })
  it.each([['cap_day', 402], ['cap_month', 402], ['cap_global', 402], ['budget_total', 402], ['spending_paused', 402], ['overrun_review', 402], ['config_invalid', 402], ['config_missing', 402], ['account_inactive', 403]])('denial %s: no dispatch, status %i', async (reason, status) => {
    const provider = fakeProvider(ok())
    const r = await call(fakeLedger({ deny: reason }), provider)
    expect(provider.sent).toHaveLength(0)
    expect(r.response.status).toBe(status)
    expect(r.response.headers['x-should-retry']).toBe('false')
  })
  it('duplicate and mismatched request ids are refused without dispatch', async () => {
    const ledger = fakeLedger()
    const provider = fakeProvider(ok())
    await call(ledger, provider, { requestId: 'client-req-0001' })
    const dup = await call(ledger, provider, { requestId: 'client-req-0001' })
    const mismatch = await call(ledger, provider, { requestId: 'client-req-0001', body: body({ max_tokens: 101 }) })
    expect(dup.outcome).toBe('duplicate')
    expect(mismatch.outcome).toBe('mismatch')
    expect(dup.response.status).toBe(409)
    expect(provider.sent).toHaveLength(1)
  })
  it('the same request id under another account is a different request', async () => {
    const ledger = fakeLedger()
    const provider = fakeProvider(ok())
    await call(ledger, provider, { requestId: 'client-req-0002' })
    const other = await call(ledger, provider, { requestId: 'client-req-0002', userId: 'u2' })
    expect(other.outcome).toBe('settled')
    expect(provider.sent).toHaveLength(2)
  })
})

describe('errors and timeouts release the hold', () => {
  const released = async (script, reason, extra = {}) => {
    const ledger = fakeLedger()
    const provider = fakeProvider(script)
    const r = await call(ledger, provider, extra)
    expect(provider.sent).toHaveLength(1)
    expect(r.outcome).toBe('released')
    expect(r.reason).toBe(reason)
    const [row] = ledger.rows.values()
    expect(row.state).toBe('released')
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.calls).toEqual(['reserve', 'release'])
    return r
  }
  it('provider timeout', async () => {
    const r = await released('hang', 'timeout', { timeoutMs: 20 })
    expect(r.response.status).toBe(504)
    expect(r.response.headers['x-should-retry']).toBe('false')
  })
  it('network loss / interrupted response', () => released('network', 'network_error'))
  it('5xx and 529 overload', async () => {
    await released({ status: 500, body: { type: 'error', error: { type: 'api_error' } } }, 'provider_status_500')
    await released({ status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } }, 'provider_status_529')
  })
  it.each([400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504, 529])('provider %i releases the hold and is not retryable', async (status) => {
    const ledger = fakeLedger()
    const r = await call(ledger, fakeProvider({ status, body: { type: 'error', error: { type: 'x', message: 'no' } } }))
    expect(r.outcome).toBe('released')
    expect(r.reason).toBe(`provider_status_${status}`)
    expect(r.response.status).toBe(status)
    expect(r.response.headers['x-should-retry']).toBe('false')
    const [row] = ledger.rows.values()
    expect(row.state).toBe('released')
    expect(ledger.outstanding()).toBe(0)
  })
  it('if release fails, the row stays reserved (still counted) and the run is flagged', async () => {
    const ledger = fakeLedger({ releaseFails: 2 })
    const r = await call(ledger, fakeProvider('network'))
    const [row] = ledger.rows.values()
    expect(r.outcome).toBe('release_failed')
    expect(row.state).toBe('reserved')
    expect(ledger.outstanding()).toBe(row.micro)
    expect(r.accountingFailed).toBe(true)
  })
  it('the RPC ledger releases through spend_release', () => {
    const admin = { rpc: async () => ({ data: {}, error: null }) }
    expect(Object.keys(makeRpcLedger(admin)).sort()).toEqual(['markAmbiguous', 'release', 'reserve', 'settle'])
  })
})

describe('a 2xx that cannot be priced keeps the hold', () => {
  const held = async (script, reason) => {
    const ledger = fakeLedger()
    const provider = fakeProvider(script)
    const r = await call(ledger, provider)
    expect(provider.sent).toHaveLength(1)
    expect(r.outcome).toBe('ambiguous')
    expect(r.reason).toBe(reason)
    const [row] = ledger.rows.values()
    expect(row.state).toBe('ambiguous')
    expect(ledger.outstanding()).toBe(row.micro)
    return r
  }
  it('a 200 with a non-JSON body', () => held(new Response('<html>', { status: 200 }), 'unparseable_response'))
  it('missing usage', () => held({ body: { ...ok().body, usage: undefined } }, 'missing_usage'))
  it('malformed usage', () => held(ok({ input_tokens: 'many', output_tokens: 1 }), 'malformed_usage'))
  it('an unexpected returned model is never priced at a fallback', () => held(ok(undefined, 'claude-haiku-5-5'), 'unexpected_model'))
  it('usage with charges the table does not model', () => held(ok({ input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 2 } }), 'server_tool_use'))
  it('if marking ambiguous fails, the row stays reserved (still counted) and the run is flagged', async () => {
    const ledger = fakeLedger({ ambiguousFails: 2 })
    const r = await call(ledger, fakeProvider({ body: { ...ok().body, usage: undefined } }))
    const [row] = ledger.rows.values()
    expect(row.state).toBe('reserved')
    expect(ledger.outstanding()).toBe(row.micro)
    expect(r.accountingFailed).toBe(true)
  })
})

describe('settlement', () => {
  it('a transient settlement failure is retried once (idempotent) and succeeds', async () => {
    const ledger = fakeLedger({ settleFails: 1 })
    const r = await call(ledger, fakeProvider(ok()))
    expect(r.outcome).toBe('settled')
    expect(ledger.calls.filter((c) => c === 'settle')).toHaveLength(2)
  })
  it('a persistent settlement failure keeps the reservation and flags the run', async () => {
    const ledger = fakeLedger({ settleFails: 5 })
    const provider = fakeProvider(ok())
    const r = await call(ledger, provider)
    expect(r.outcome).toBe('settlement_failed')
    expect(r.accountingFailed).toBe(true)
    expect(r.response.status).toBe(200) // the reader still gets what was paid for
    const [row] = ledger.rows.values()
    expect(row.state).toBe('reserved')
    expect(ledger.outstanding()).toBe(row.micro)
  })
  it('usage above the bound is recorded in full and flagged as an overrun', async () => {
    const ledger = fakeLedger()
    const r = await call(ledger, fakeProvider(ok({ input_tokens: 5_000_000, output_tokens: 5 })))
    expect(r.outcome).toBe('overrun')
    expect(r.overrun).toBe(true)
    const [row] = ledger.rows.values()
    expect(row.actual).toBeGreaterThan(row.micro)
  })
  it('a conflicting ledger state stops the run', async () => {
    const r = await call(fakeLedger({ settleStatus: 'conflict' }), fakeProvider(ok()))
    expect(r.accountingFailed).toBe(true)
  })
})

describe('denial responses', () => {
  it('cap stops read as cap reached to the app; pauses carry their own message', () => {
    expect(JSON.parse(denialResponse('cap_day').body).error.type).toBe('cap_reached')
    expect(JSON.parse(denialResponse('spending_paused').body).error.message).toMatch(/paused/)
    expect(denialResponse('budget_total').headers['x-verastar-denial']).toBe('budget_total')
  })
})

describe('the scheduler\'s guarded fetch with the real SDK', () => {
  const sdk = (fetch, maxRetries = 2) => new Anthropic({ apiKey: 'sponsor-guarded', fetch, maxRetries })
  const create = (client) => client.messages.create(body())

  it('a successful call settles through the SDK', async () => {
    const ledger = fakeLedger()
    const provider = fakeProvider(ok())
    const g = makeGuardedFetch({ ledger, dispatch: provider.dispatch, userId: 'u1' })
    const res = await create(sdk(g.fetch))
    expect(res.id).toBe('msg_1')
    expect(provider.sent).toHaveLength(1)
    expect([...ledger.rows.values()][0]).toMatchObject({ source: 'scheduler', purpose: 'scheduled-digest', state: 'settled', userId: 'u1' })
  })
  it.each([408, 429, 529])('a %i is not retried by the SDK: one dispatch, hold released, run not halted', async (status) => {
    const ledger = fakeLedger()
    const provider = fakeProvider({ status, body: { type: 'error', error: { type: 'x', message: 'busy' } } })
    const g = makeGuardedFetch({ ledger, dispatch: provider.dispatch, userId: 'u1', claimToken: 'tok' })
    const client = new Anthropic({ apiKey: 'x', fetch: g.fetch, maxRetries: 2, timeout: T.SERVER_CLIENT_TIMEOUT_MS })
    const err = await create(client).catch((e) => e)
    expect(err.status).toBe(status)
    expect(provider.sent).toHaveLength(1)
    const rows = [...ledger.rows.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('released')
    expect(ledger.outstanding()).toBe(0)
    expect(g.state.halted).toBeNull()
  })
  it('an unpriceable 2xx still halts the run and keeps the hold', async () => {
    const ledger = fakeLedger()
    const provider = fakeProvider({ body: { ...ok().body, usage: undefined } })
    const g = makeGuardedFetch({ ledger, dispatch: provider.dispatch, userId: 'u1' })
    await create(sdk(g.fetch)).catch(() => {})
    expect([...ledger.rows.values()][0].state).toBe('ambiguous')
    expect(g.state.halted).toBe('ambiguous')
    const again = await create(sdk(g.fetch)).catch((e) => e)
    expect(again.status).toBe(402)
    expect(provider.sent).toHaveLength(1)
  })
  it('a cap denial reaches the app as CapReached and is not retried', async () => {
    const ledger = fakeLedger({ deny: 'cap_day' })
    const provider = fakeProvider(ok())
    const g = makeGuardedFetch({ ledger, dispatch: provider.dispatch, userId: 'u1' })
    const err = await create(sdk(g.fetch)).catch((e) => e)
    expect(err.status).toBe(402)
    expect(isCapReached(err)).toBe(true)
    expect(ledger.calls).toEqual(['reserve'])
    expect(provider.sent).toHaveLength(0)
  })
  it('after an accounting failure the run is halted: later attempts neither reserve nor dispatch', async () => {
    const ledger = fakeLedger({ settleFails: 10 })
    const provider = fakeProvider(ok())
    const g = makeGuardedFetch({ ledger, dispatch: provider.dispatch, userId: 'u1' })
    await create(sdk(g.fetch))
    expect(g.state.halted).toBe('settlement_failed')
    const reserves = ledger.calls.filter((c) => c === 'reserve').length
    const err = await create(sdk(g.fetch)).catch((e) => e)
    expect(err.status).toBe(402)
    expect(isCapReached(err)).toBe(true)
    expect(ledger.calls.filter((c) => c === 'reserve').length).toBe(reserves)
    expect(provider.sent).toHaveLength(1)
  })
  it('a reserve outage stops the run as a recoverable stop, not an SDK retry storm', async () => {
    const ledger = fakeLedger({ reserveThrows: true })
    const provider = fakeProvider(ok())
    const g = makeGuardedFetch({ ledger, dispatch: provider.dispatch, userId: 'u1' })
    const err = await create(sdk(g.fetch)).catch((e) => e)
    expect(err.status).toBe(402)
    expect(ledger.calls).toEqual(['reserve'])
    expect(provider.sent).toHaveLength(0)
    expect(g.state.halted).toBe('accounting_unavailable')
  })
  it('only POST /v1/messages is reachable', async () => {
    const g = makeGuardedFetch({ ledger: fakeLedger(), dispatch: fakeProvider(ok()).dispatch, userId: 'u1' })
    expect((await g.fetch('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await g.fetch('https://api.anthropic.com/v1/messages', { method: 'GET' })).status).toBe(404)
  })
  it('scheduler attempts carry the claim token; a lost claim means zero dispatches and a halted run', async () => {
    let owner = 'tok-1'
    const ledger = fakeLedger({ ownsClaim: (_u, token) => token === owner })
    const provider = fakeProvider(ok())
    const g = makeGuardedFetch({ ledger, dispatch: provider.dispatch, userId: 'u1', claimToken: 'tok-1' })
    await create(sdk(g.fetch))
    expect([...ledger.rows.values()][0].claimToken).toBe('tok-1')
    owner = 'tok-2' // a successor took the account
    const err = await create(sdk(g.fetch)).catch((e) => e)
    expect(err.status).toBe(402)
    expect(err.headers.get('x-verastar-denial')).toBe('claim_lost')
    expect(provider.sent).toHaveLength(1)
    expect(g.state.halted).toBe('claim_lost')
    await create(sdk(g.fetch)).catch(() => {})
    expect(ledger.calls.filter((c) => c === 'reserve')).toHaveLength(2)
    expect(provider.sent).toHaveLength(1)
  })
  it('the RPC ledger sends the claim token (null for the proxy)', async () => {
    const calls = []
    const admin = { rpc: async (fn, args) => { calls.push([fn, args]); return { data: { status: 'denied', reason: 'cap_day' }, error: null } } }
    const ledger = makeRpcLedger(admin)
    await ledger.reserve({ userId: 'u', requestId: 'r-00000001', fingerprint: 'f', model: 'm', purpose: 'p', source: 'scheduler', micro: 1, maxInputTokens: 1, maxOutputTokens: 1, claimToken: 'tok' })
    await ledger.reserve({ userId: 'u', requestId: 'r-00000002', fingerprint: 'f', model: 'm', purpose: 'p', source: 'proxy', micro: 1, maxInputTokens: 1, maxOutputTokens: 1 })
    expect(calls.map(([fn, a]) => [fn, a.p_claim_token])).toEqual([['spend_reserve', 'tok'], ['spend_reserve', null]])
  })
  it('timeouts: the boundary gives up first, an admitted attempt ends before its lease, the proxy beats the platform', () => {
    expect(T.PROVIDER_TIMEOUT_MS).toBeLessThan(T.SERVER_CLIENT_TIMEOUT_MS)
    expect(T.PROVIDER_TIMEOUT_MS).toBeLessThan(T.SPONSORED_CLIENT_TIMEOUT_MS)
    expect(T.SERVER_CLIENT_TIMEOUT_MS).toBeLessThan(T.CLAIM_STALE_SECONDS * 1000)
    expect(T.PROVIDER_TIMEOUT_MS).toBeLessThan(T.EDGE_IDLE_TIMEOUT_MS)
    expect(T.COUNT_TIMEOUT_MS).toBeLessThan(T.PROVIDER_TIMEOUT_MS)
  })
  it('CapReachedError is what the digest runner keys on', () => {
    expect(isCapReached(new CapReachedError())).toBe(true)
  })
})

describe('request-sized reservations', () => {
  const holdFor = (raw) => reservationCharge(MODEL, { rawInputTokens: raw, maxOutputTokens: 100 })
  it('a counted typical call reserves far below $2, and settlement reconciles to actual usage', async () => {
    const ledger = fakeLedger()
    const r = await call(ledger, fakeProvider(ok()), { countTokens: async () => 800 })
    const [row] = ledger.rows.values()
    expect(row.micro).toBe(holdFor(800).micro)
    expect(row.micro).toBeLessThan(20_000)
    expect(row.micro).toBeGreaterThan(r.micro)
    expect(r.outcome).toBe('settled')
    expect(row.state).toBe('settled')
    expect(row.actual).toBe(70)
    expect(ledger.outstanding()).toBe(0)
  })
  it('a ranking-sized count plus max output is still far below the context-window ceiling', () => {
    const ranking = reservationCharge(MODEL, { rawInputTokens: 12_000, maxOutputTokens: 8_192 })
    expect(ranking.micro).toBeLessThan(200_000)
    expect(ranking.micro).toBeGreaterThan(0)
    expect(checkPaidRequest({ ...body(), max_tokens: 8192 }).bound.micro).toBeGreaterThan(2_000_000)
  })
  it('count timeout, error, and a zero count fall back to the local estimate, never to zero', async () => {
    const estimate = holdFor(localInputTokenEstimate(checkPaidRequest(body()).forwardText)).micro
    const cases = [
      { countTokens: () => new Promise(() => {}), countTimeoutMs: 20 },
      { countTokens: async () => { throw new Error('count down') } },
      { countTokens: async () => 0 },
      { countTokens: async () => 1.5 },
    ]
    for (const extra of cases) {
      const ledger = fakeLedger()
      const r = await call(ledger, fakeProvider(ok()), extra)
      expect(r.outcome).toBe('settled')
      const [row] = ledger.rows.values()
      expect(row.micro).toBe(estimate)
      expect(row.micro).toBeGreaterThan(0)
      expect(row.micro).toBeLessThan(2_000_000)
    }
  })
  it('the cap still denies a hold that does not fit, including one far below $2', async () => {
    const fits = fakeLedger({ capMicro: 50_000 })
    const provider = fakeProvider(ok())
    const okCall = await call(fits, provider, { countTokens: async () => 100 })
    expect(okCall.outcome).toBe('settled')
    expect(provider.sent).toHaveLength(1)
    expect([...fits.rows.values()][0].micro).toBeLessThan(50_000)
    const tight = fakeLedger({ capMicro: 1 })
    const denied = await call(tight, fakeProvider(ok()), { countTokens: async () => 100 })
    expect(denied.outcome).toBe('denied')
    expect(denied.reason).toBe('cap_day')
    expect(tight.rows.size).toBe(0)
  })
  it('parallel reservations cannot jointly exceed the cap', async () => {
    const micro = holdFor(localInputTokenEstimate(checkPaidRequest(body()).forwardText)).micro
    const ledger = fakeLedger({ capMicro: micro * 2 })
    let releaseGate
    const gate = new Promise((resolve) => { releaseGate = resolve })
    const sent = []
    const dispatch = async (text) => {
      sent.push(JSON.parse(text))
      await gate
      return new Response(JSON.stringify(ok().body), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } })
    }
    const pending = Array.from({ length: 6 }, (_, i) => guardedProviderCall({
      ledger, dispatch, userId: 'u1', body: body(), source: 'proxy', purpose: 'test', requestId: `parallel-req-${i}`,
    }))
    for (let i = 0; i < 50 && ledger.calls.filter((c) => c === 'reserve').length < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(ledger.calls.filter((c) => c === 'reserve')).toHaveLength(6)
    expect([...ledger.rows.values()].filter((r) => r.state === 'reserved')).toHaveLength(2)
    expect(ledger.outstanding()).toBe(micro * 2)
    expect(sent).toHaveLength(2)
    releaseGate()
    const results = await Promise.all(pending)
    expect(results.filter((r) => r.outcome === 'settled')).toHaveLength(2)
    expect(results.filter((r) => r.outcome === 'denied' && r.reason === 'cap_day')).toHaveLength(4)
    expect(sent).toHaveLength(2)
    expect(ledger.outstanding()).toBe(0)
    expect(ledger.charged()).toBe(70 * 2)
    expect(ledger.charged()).toBeLessThanOrEqual(micro * 2)
  })
  it('the counting call uses the count_tokens endpoint and rejects an unusable count', async () => {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ input_tokens: 42 }))
    }
    const n = await anthropicTokenCounter('sk-test', fetchImpl)({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, {})
    expect(n).toBe(42)
    expect(seen[0].url).toBe(countTokensUrl(ANTHROPIC_URL))
    expect(Object.keys(seen[0].init.headers).sort()).toEqual(['anthropic-version', 'content-type', 'x-api-key'])
    const bad = anthropicTokenCounter('sk-test', async () => new Response(JSON.stringify({ input_tokens: 0 })))
    await expect(bad({})).rejects.toThrow(/unusable/)
    const down = anthropicTokenCounter('sk-test', async () => new Response('no', { status: 503 }))
    await expect(down({})).rejects.toThrow(/503/)
  })
})

describe('the local-stack fake-provider override', () => {
  const local = { SUPABASE_URL: 'http://kong:8000', ANTHROPIC_API_KEY: 'sk-fake-local', VERASTAR_TEST_PROVIDER_URL: 'http://host.docker.internal:8787/v1/messages' }
  it('production never sees it: no override means the real provider', () => {
    expect(resolveProviderUrl({ SUPABASE_URL: 'https://x.supabase.co', ANTHROPIC_API_KEY: 'sk-ant-real' })).toEqual({ ok: true, url: ANTHROPIC_URL })
  })
  it('is honored only on a local stack with a fake key and a local http target', () => {
    expect(resolveProviderUrl(local)).toMatchObject({ ok: true, test: true, url: local.VERASTAR_TEST_PROVIDER_URL })
  })
  it.each([
    ['a hosted project', { SUPABASE_URL: 'https://abc.supabase.co' }],
    ['a real-looking key', { ANTHROPIC_API_KEY: 'sk-ant-api03-x' }],
    ['a remote target', { VERASTAR_TEST_PROVIDER_URL: 'http://evil.example/v1/messages' }],
    ['https to a public host', { VERASTAR_TEST_PROVIDER_URL: 'https://api.example.com/v1/messages' }],
    ['a different path', { VERASTAR_TEST_PROVIDER_URL: 'http://127.0.0.1:8787/collect' }],
    ['garbage', { VERASTAR_TEST_PROVIDER_URL: 'not a url' }],
  ])('refuses (fail closed) with %s', (_l, patch) => {
    expect(resolveProviderUrl({ ...local, ...patch }).ok).toBe(false)
  })
})
