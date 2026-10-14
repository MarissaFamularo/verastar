// Server-side beta audit probes (2026-10-14). Every test PINS CURRENT BEHAVIOR that the audit
// report calls a defect or a risk, so the file is green today and a test goes red when the
// behavior is fixed (update or delete it then). Names start with the report's defect id.
// Updated later on 2026-10-14 for the repairs that landed as local code and migrations
// (D-2, D-4, D-10, D-11, D-12: now pinned as FIXED); the rest still pin the open state.
// Pure: fakes only (spendingFakes.js), no network, no database. The SQL-level facts that
// need PostgreSQL (events delete resets limits, past ends_at enrolls a dead account, alias
// enumeration, in-flight digest write refusal) were reproduced on a disposable local
// database and are pinned here as static checks of the migration text.
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), lookupNpi: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }))
vi.mock('../../supabase/functions/_shared/npiMatch.js', async (original) => ({ ...await original(), lookupNpi: mocks.lookupNpi }))

import { handleModelRequest } from '../../supabase/functions/model/handler.js'
import { handleDigestRun, ATTEMPTS_PER_DAY } from '../../supabase/functions/digest-run/handler.js'
import { handleGmailCanonicalOtp, safeRedirect } from '../../supabase/functions/gmail-canonical-otp/handler.js'
import { hasNpiMatch } from '../../supabase/functions/_shared/npiMatch.js'
import { reservationCharge, localInputTokenEstimate } from '../../supabase/functions/_shared/tokenReserve.js'
import { COUNT_TIMEOUT_MS, PROVIDER_TIMEOUT_MS, EDGE_IDLE_TIMEOUT_MS, CLAIM_STALE_SECONDS, SERVER_CLIENT_TIMEOUT_MS } from '../../supabase/functions/_shared/timeouts.js'
import { fakeLedger, fakeProvider } from './spendingFakes.js'

const root = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url))
const read = (rel) => readFileSync(root(rel), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------
// model proxy
// ---------------------------------------------------------------------------------------
const HASH = 'd'.repeat(64)
const goodBody = { model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'extract' }] }
const okResponse = { body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } } }

function proxyAdmin({ cacheRow = null } = {}) {
  const ops = []
  const from = (table) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => {
        if (table === 'sponsored_accounts') return { data: { user_id: 'user-A', active: true, ends_at: null }, error: null }
        if (table === 'evidence_cache_trusted') return { data: cacheRow, error: null }
        return { data: null, error: null }
      },
      insert: (row) => { ops.push({ table, row }); return Promise.resolve({ error: null }) },
    }
    return chain
  }
  return { from, ops }
}
const proxyReq = (headers = {}, body = goodBody) => new Request('https://fn.example/functions/v1/model/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer jwt', ...headers }, body: JSON.stringify(body),
})

describe('model proxy', () => {
  it('B-OK: an anon-key bearer (not a user JWT) is refused before any body read or spend', async () => {
    const ledger = fakeLedger()
    const provider = fakeProvider(okResponse)
    const res = await handleModelRequest(proxyReq(), { getUser: async () => null, admin: proxyAdmin(), ledger, dispatch: provider.dispatch })
    expect(res.status).toBe(401)
    expect(ledger.calls).toEqual([])
    expect(provider.sent).toHaveLength(0)
  })

  it('R-5 (low): CORS is wildcard on every function; auth is the bearer token, so this only matters if a cookie auth is ever added', async () => {
    const res = await handleModelRequest(new Request('https://fn.example/functions/v1/model/v1/messages', { method: 'OPTIONS' }), {})
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('D-6 (low): a shared-cache hit is served before the spending guard, so it works while spending is paused and writes one unthrottled model_spend row per hit', async () => {
    const cacheRow = { extraction: { quantities: [] }, model: 'claude-sonnet-5-5', source_hash: HASH, provenance: { writer: 'digest-run' } }
    const admin = proxyAdmin({ cacheRow })
    const ledger = fakeLedger({ deny: 'spending_paused' })
    const provider = fakeProvider(okResponse)
    const deps = { getUser: async () => ({ id: 'user-A' }), admin, ledger, dispatch: provider.dispatch }
    for (let i = 0; i < 25; i++) {
      const res = await handleModelRequest(proxyReq({ 'x-verastar-cache': `123|v1|${HASH}|full_text` }), deps)
      expect(res.status).toBe(200)
      expect(res.headers.get('x-verastar-cache')).toBe('hit')
    }
    expect(ledger.calls).toEqual([])
    expect(provider.sent).toHaveLength(0)
    expect(admin.ops.filter((o) => o.table === 'model_spend' && o.row.cache_hit === true && o.row.usd === 0)).toHaveLength(25)
  })

  it('D-5 (low): a denied request still triggers the Anthropic count_tokens call first (an unreserved provider request, 1 MB bodies allowed)', async () => {
    const countTokens = vi.fn(async () => 5000)
    const ledger = fakeLedger({ deny: 'cap_day' })
    const res = await handleModelRequest(proxyReq(), { getUser: async () => ({ id: 'user-A' }), admin: proxyAdmin(), ledger, dispatch: fakeProvider(okResponse).dispatch, countTokens })
    expect(res.status).toBe(402)
    expect(countTokens).toHaveBeenCalledTimes(1)
  })

  it('D-7 (low): the browser chooses the ledger purpose, including the scheduler\'s own label', async () => {
    const ledger = fakeLedger()
    const res = await handleModelRequest(proxyReq({ 'x-verastar-purpose': 'scheduled-digest' }), { getUser: async () => ({ id: 'user-A' }), admin: proxyAdmin(), ledger, dispatch: fakeProvider(okResponse).dispatch })
    expect(res.status).toBe(200)
    const [row] = ledger.rows.values()
    expect(row).toMatchObject({ purpose: 'scheduled-digest', source: 'proxy' })
  })

  it('O-3 (medium, operational): a provider 429/529/5xx is released and passed through with x-should-retry:false, so the SDK never retries transient overload', async () => {
    for (const status of [429, 500, 529]) {
      const ledger = fakeLedger()
      const provider = fakeProvider({ status, body: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } })
      const res = await handleModelRequest(proxyReq(), { getUser: async () => ({ id: 'user-A' }), admin: proxyAdmin(), ledger, dispatch: provider.dispatch })
      expect(res.status).toBe(status)
      expect(res.headers.get('x-should-retry')).toBe('false')
      expect([...ledger.rows.values()][0].state).toBe('released')
    }
  })

  it('D-5b (low): a worst-case 900 KB body reserves about $1.45 on the estimate path, so two in flight leave no room under a $3 day', () => {
    const raw = localInputTokenEstimate('x'.repeat(900_000))
    const usd = reservationCharge('claude-sonnet-5-5', { rawInputTokens: raw, maxOutputTokens: 32_000 }).micro / 1e6
    expect(usd).toBeGreaterThan(1.4)
    expect(usd).toBeLessThan(1.5)
    expect(Math.floor(3 / usd)).toBe(2)
  })

  it('O-1 (medium, operational): timeouts leave 2 s between count+provider and the platform idle limit; reserve and settle round trips are unbudgeted', () => {
    expect(COUNT_TIMEOUT_MS + PROVIDER_TIMEOUT_MS).toBe(148_000)
    expect(EDGE_IDLE_TIMEOUT_MS - (COUNT_TIMEOUT_MS + PROVIDER_TIMEOUT_MS)).toBe(2_000)
    // The scheduler client timeout equals the idle limit and is still inside the claim lease.
    expect(SERVER_CLIENT_TIMEOUT_MS).toBe(EDGE_IDLE_TIMEOUT_MS)
    expect(SERVER_CLIENT_TIMEOUT_MS / 1000).toBeLessThan(CLAIM_STALE_SECONDS)
  })
})

// ---------------------------------------------------------------------------------------
// digest-run
// ---------------------------------------------------------------------------------------
// A tiny in-memory database for the handler: rows in registration order; .order() is a
// no-op here, so the handler's own orderByAttempt is what the D-2 test exercises.
function digestDb({ rows, accounts = null, record = null }) {
  const t = {
    digest_schedules: rows.map((r) => ({ enabled: true, hour_local: 0, timezone: 'UTC', claimed_at: null, claim_token: null, last_run_at: null, last_attempt_at: null, attempt_day: null, attempts_today: 0, ...r })),
    sponsored_accounts: (accounts || rows.map((r) => ({ user_id: r.user_id, active: true, ends_at: null }))),
    kv: record ? [{ user_id: record.user_id, collection: 'digests', key: 'daily:latest', value: record.value }] : [],
    events: [],
  }
  const rpcCalls = []
  let n = 0
  const rpcs = {
    spend_status: () => ({ allowed: true, reason: null }),
    digest_claim: ({ p_user_id }) => {
      const row = t.digest_schedules.find((r) => r.user_id === p_user_id && r.enabled)
      if (!row || row.claimed_at) return null
      row.claimed_at = '2026-10-14T10:00:00Z'
      row.claim_token = `tok-${++n}`
      return row.claim_token
    },
    digest_claim_finish: ({ p_user_id, p_token, p_finished }) => {
      const row = t.digest_schedules.find((r) => r.user_id === p_user_id && r.claim_token === p_token)
      if (!row) return false
      // 20261014121000_digest_attempts.sql: every finish stamps the attempt. A fake clock
      // that advances per finish keeps the ordering observable.
      const stamp = new Date(Date.parse('2026-10-14T10:00:00Z') + ++stamps * 1000).toISOString()
      Object.assign(row, { claimed_at: null, claim_token: null, ...(p_finished ? { last_run_at: '2026-10-14T10:00:00Z' } : {}),
        last_attempt_at: stamp, attempts_today: row.attempt_day === '2026-10-14' ? row.attempts_today + 1 : 1, attempt_day: '2026-10-14' })
      return true
    },
    digest_claim_release: ({ p_user_id, p_token }) => {
      const row = t.digest_schedules.find((r) => r.user_id === p_user_id && r.claim_token === p_token)
      if (!row) return false
      Object.assign(row, { claimed_at: null, claim_token: null })
      return true
    },
  }
  let stamps = 0
  const from = (table) => {
    const filters = []
    let payload = null
    const rowsNow = () => t[table].filter((r) => filters.every((f) => f(r)))
    const chain = {
      select: () => chain,
      order: () => chain,
      eq: (k, v) => { filters.push((r) => r[k] === v); return chain },
      in: (k, vs) => { filters.push((r) => vs.includes(r[k])); return chain },
      is: (k, v) => { filters.push((r) => (r[k] ?? null) === v); return chain },
      maybeSingle: async () => ({ data: rowsNow()[0] ?? null, error: null }),
      update: (p) => { payload = p; return chain },
      insert: (row) => { t[table].push(row); return Promise.resolve({ error: null }) },
      then: (res, rej) => {
        if (payload) for (const r of rowsNow()) Object.assign(r, payload)
        return Promise.resolve({ data: payload ? null : rowsNow(), error: null }).then(res, rej)
      },
    }
    return chain
  }
  return { t, rpcCalls, admin: { from, rpc: async (name, args) => { rpcCalls.push(name); return { data: rpcs[name](args), error: null } } } }
}

function digestDeps(db, { run, user = null, cronSecret = 'cron', now = '2026-10-14T10:00:00Z' } = {}) {
  const ran = []
  return {
    ran,
    deps: {
      cronSecret,
      getUser: async () => user,
      admin: db.admin,
      ledger: {},
      dispatch: async () => { throw new Error('no provider call expected') },
      now: () => new Date(now),
      app: {
        makeSupabaseStore: () => ({ get: async () => null, all: async () => [] }),
        schedulerMayRun: () => true,
        runDailyDigest: async (...a) => run(...a),
      },
      makeClient: () => ({}),
      runInScope: (scope, fn) => { ran.push(scope.userId); return fn() },
      provenance: { writer: 'digest-run', bundle_source_sha256: 'b'.repeat(64) },
    },
  }
}
const cronReq = () => new Request('https://fn/digest-run', { method: 'POST', headers: { 'x-cron-secret': 'cron' } })
const userReq = (body = {}) => new Request('https://fn/digest-run', { method: 'POST', headers: { authorization: 'Bearer u' }, body: JSON.stringify(body) })

describe('digest-run', () => {
  it('D-2 FIXED: a persistently failing account alternates with the rest (ordered by last attempt) and is left alone at the day\'s attempt cap', async () => {
    const db = digestDb({ rows: [{ user_id: 'P' }, { user_id: 'Q' }] })
    const h = digestDeps(db, { run: async () => ({ phase: 'error', note: 'PubMed search failed for 2 topics' }) })
    const picked = []
    for (let i = 0; i < 6; i++) picked.push((await (await handleDigestRun(cronReq(), h.deps)).json()).user_id)
    expect(picked).toEqual(['P', 'Q', 'P', 'Q', 'P', 'Q'])
    expect(db.t.digest_schedules.map((r) => r.attempts_today)).toEqual([3, 3])
    expect(db.t.digest_schedules.every((r) => r.last_attempt_at && r.last_run_at === null)).toBe(true)
    // Q recovers and finishes; P keeps failing until its cap, then the tick has nothing to do.
    const q = db.t.digest_schedules.find((r) => r.user_id === 'Q')
    q.enabled = false
    const more = []
    for (let i = 0; i < ATTEMPTS_PER_DAY; i++) more.push((await (await handleDigestRun(cronReq(), h.deps)).json()))
    expect(more.filter((o) => o.ran).map((o) => o.user_id)).toEqual(Array(ATTEMPTS_PER_DAY - 3).fill('P'))
    expect(more.filter((o) => !o.ran).every((o) => o.reason === 'attempt cap reached')).toBe(true)
    expect(db.t.digest_schedules.find((r) => r.user_id === 'P').attempts_today).toBe(ATTEMPTS_PER_DAY)
    expect(read('supabase/functions/digest-run/handler.js')).toMatch(/\.order\('last_attempt_at'/)
  })

  it('B-OK: a wrong cron secret falls through to user auth and is refused; an unset secret silently disables cron', async () => {
    const db = digestDb({ rows: [{ user_id: 'P' }] })
    const wrong = digestDeps(db, { run: async () => ({ phase: 'done' }) })
    const res1 = await handleDigestRun(new Request('https://fn/digest-run', { method: 'POST', headers: { 'x-cron-secret': 'nope' } }), wrong.deps)
    expect(res1.status).toBe(401)
    const unset = digestDeps(db, { run: async () => ({ phase: 'done' }), cronSecret: null })
    const res2 = await handleDigestRun(cronReq(), unset.deps)
    expect(res2.status).toBe(401)
    expect(wrong.ran).toEqual([])
  })

  it('B-OK: a signed-in caller can only ever run their own schedule, whatever else is due', async () => {
    const db = digestDb({ rows: [{ user_id: 'P' }, { user_id: 'Q' }] })
    const h = digestDeps(db, { run: async () => ({ phase: 'done', papers: 1, read: 1 }), user: { id: 'Q' } })
    const out = await (await handleDigestRun(userReq({ user_id: 'P' }), h.deps)).json()
    expect(out.user_id).toBe('Q')
    expect(h.ran).toEqual(['Q'])
  })

  it('B-OK: a non-sponsored caller with a self-inserted schedule row reaches no claim and no run', async () => {
    const db = digestDb({ rows: [{ user_id: 'X' }], accounts: [] })
    const h = digestDeps(db, { run: async () => ({ phase: 'done' }), user: { id: 'X' } })
    const out = await (await handleDigestRun(userReq(), h.deps)).json()
    expect(out.ran).toBe(false)
    expect(db.rpcCalls).not.toContain('digest_claim')
    expect(h.ran).toEqual([])
  })

  it('D-8 (low): the reader owns timezone, so moving it across the date line re-opens "ran today" and buys a second scheduled run the same real day', async () => {
    const lastRun = '2026-10-14T11:00:00Z'
    const now = '2026-10-14T16:00:00Z'
    const ny = digestDb({ rows: [{ user_id: 'U', timezone: 'America/New_York', last_run_at: lastRun }] })
    const a = await (await handleDigestRun(cronReq(), digestDeps(ny, { run: async () => ({ phase: 'done' }), now }).deps)).json()
    expect(a).toMatchObject({ ran: false, reason: 'already ran today' })
    const tokyo = digestDb({ rows: [{ user_id: 'U', timezone: 'Asia/Tokyo', last_run_at: lastRun }] })
    const b = await (await handleDigestRun(cronReq(), digestDeps(tokyo, { run: async () => ({ phase: 'done' }), now }).deps)).json()
    expect(b.ran).toBe(true)
  })

  it('D-3 (medium, operational): a held run leaves the schedule claimable only by an operator; the tick reports phase held and never marks the day run', async () => {
    const db = digestDb({ rows: [{ user_id: 'P' }] })
    const h = digestDeps(db, { run: async () => ({ phase: 'held', papers: 3, read: 3, note: 'held' }) })
    const out = await (await handleDigestRun(cronReq(), h.deps)).json()
    expect(out.phase).toBe('held')
    expect(db.t.digest_schedules[0].last_run_at).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------
// gmail-canonical-otp
// ---------------------------------------------------------------------------------------
const VERIFY = '22222222-2222-4222-8222-222222222222'
const otpReq = (body) => new Request('https://fn/otp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('gmail-canonical-otp', () => {
  it('D-4 FIXED: a verify ticket burns at the fifth wrong code; the 500-guess sweep asks Auth five times and the right code afterwards is refused', async () => {
    let attempts = 0
    let failures = 0
    let alive = true
    const deps = {
      readVerify: vi.fn(async () => (alive ? 'victim@gmail.com' : '')),
      consumeVerify: vi.fn(async () => { alive = false }),
      failVerify: vi.fn(async () => { failures++; if (failures >= 5) alive = false; return Math.max(0, 5 - failures) }),
      verifyOtp: vi.fn(async (_email, code) => { attempts++; return code === '000500' ? { access_token: 'a', refresh_token: 'r' } : null }),
    }
    const statuses = []
    for (let i = 0; i < 500; i++) {
      const res = await handleGmailCanonicalOtp(otpReq({ action: 'verify', verifyTicket: VERIFY, code: String(i).padStart(6, '0') }), deps)
      expect(res.status).toBe(400)
      statuses.push((await res.json()).status)
    }
    expect(statuses.slice(0, 5)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'locked'])
    expect(new Set(statuses.slice(5))).toEqual(new Set(['invalid']))
    expect(attempts).toBe(5)
    expect(deps.failVerify).toHaveBeenCalledTimes(5)
    const late = await handleGmailCanonicalOtp(otpReq({ action: 'verify', verifyTicket: VERIFY, code: '000500' }), deps)
    expect(late.status).toBe(400)
    expect(attempts).toBe(5)
  })

  it('D-9 (low): safeRedirect keeps the origin of any http(s) URL, so the only open-redirect guard is the Supabase Auth allow-list', () => {
    expect(safeRedirect('https://evil.example/steal?x=1')).toBe('https://evil.example')
    expect(safeRedirect('http://localhost:5173/app')).toBe('http://localhost:5173')
    expect(safeRedirect('javascript:alert(1)')).toBe('')
    expect(safeRedirect('https://user:pw@evil.example/')).toBe('')
  })

  it('B-OK: non-UUID tickets and non-numeric codes never reach the database', async () => {
    const deps = { takeSend: vi.fn(), readVerify: vi.fn(), verifyOtp: vi.fn() }
    expect((await handleGmailCanonicalOtp(otpReq({ action: 'send', ticket: "1' or 1=1" }), deps)).status).toBe(400)
    expect((await handleGmailCanonicalOtp(otpReq({ action: 'verify', verifyTicket: VERIFY, code: '12ab56' }), deps)).status).toBe(400)
    expect(deps.takeSend).not.toHaveBeenCalled()
    expect(deps.readVerify).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------
// match-npi and redeem-invite (the real index.ts files behind a Deno stub)
// ---------------------------------------------------------------------------------------
const receipt = { version: 1, npi: '1234567893', firstName: 'Jane', lastName: 'Doe', matchedAt: '2026-10-12T12:00:00Z' }
const authedReq = (body) => new Request('https://example.test/', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('rate limits kept in the user-writable events table', () => {
  let handlers
  let events
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    handlers = {}
    events = []
    const user = { id: 'u1', app_metadata: {} }
    // A count that, like the network, answers after a delay, and an insert that lands later.
    const eventsTable = {
      select: () => {
        const f = []
        const chain = { eq: (k, v) => { f.push([k, v]); return chain }, gte: async () => { await sleep(5); return { count: events.filter((e) => f.every(([k, v]) => e[k] === v)).length, error: null } } }
        return chain
      },
      insert: async (row) => { await sleep(5); events.push(row); return { error: null } },
    }
    const lookupFor = (table) => { const l = { eq: () => l, maybeSingle: async () => ({ data: table === 'sponsor_invites' ? { revoked_at: null, expires_at: null, uses: 0, max_uses: 10 } : null }) }; return l }
    const admin = {
      from: (table) => (table === 'events' ? eventsTable : { select: () => lookupFor(table) }),
      auth: { admin: { updateUserById: vi.fn(async () => ({ error: null })) } },
      rpc: vi.fn(async (name) => (name === 'spending_contract_version' ? { data: '2026-10-09.spending-v2' } : { data: { status: 'enrolled' } })),
    }
    mocks.createClient.mockImplementation((_url, key) => (key === 'service' ? admin : { auth: { getUser: async () => ({ data: { user } }) } }))
    mocks.lookupNpi.mockResolvedValue({ status: 'mismatch' })
    let name = 'match'
    vi.stubGlobal('Deno', { env: { get: (k) => ({ SUPABASE_URL: 'https://test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' })[k] }, serve: (h) => { handlers[name] = h } })
    await import('../../supabase/functions/match-npi/index.ts')
    name = 'redeem'
    await import('../../supabase/functions/redeem-invite/index.ts')
  })

  it('D-1a (high): 20 parallel match-npi calls all pass a 10/hour limit (count-then-insert is not atomic)', async () => {
    const input = { firstName: 'Jane', lastName: 'Doe', npi: '1234567893' }
    const responses = await Promise.all(Array.from({ length: 20 }, () => handlers.match(authedReq(input))))
    expect(responses.filter((r) => r.status === 429)).toHaveLength(0)
    expect(mocks.lookupNpi).toHaveBeenCalledTimes(20)
  })

  it('D-1b (high): 20 parallel redeem-invite guesses all pass a 5/hour limit and each learns the code state', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => handlers.redeem(authedReq({ code: 'GUESS' }))))
    expect(responses.filter((r) => r.status === 429)).toHaveLength(0)
    expect((await responses[0].json()).status).toBe('npi_required')
  })

  it('D-1c (high): the counter is the caller\'s own events rows, which the RLS lets them delete', async () => {
    const input = { firstName: 'Jane', lastName: 'Doe', npi: '1234567893' }
    for (let i = 0; i < 10; i++) await handlers.match(authedReq(input))
    expect((await handlers.match(authedReq(input))).status).toBe(429)
    events.length = 0 // what `delete from events where type = 'npi_attempt'` does under events_delete_own
    expect((await handlers.match(authedReq(input))).status).not.toBe(429)
    const policies = read('supabase/migrations/20260721000000_kv_events_with_rls.sql')
    expect(policies).toMatch(/create policy "events_delete_own" on events for delete to authenticated/)
    expect(policies).toMatch(/create policy "events_update_own" on events for update to authenticated/)
  })

  it('B-OK: a client-writable user_metadata receipt is ignored; only app_metadata counts', () => {
    expect(hasNpiMatch({ user_metadata: { npi_match: receipt } })).toBe(false)
    expect(hasNpiMatch({ app_metadata: { npi_match: receipt } })).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------
// migrations and deploy facts (static; the SQL behavior was reproduced on a local database)
// ---------------------------------------------------------------------------------------
describe('migration and deploy facts', () => {
  const spending = read('supabase/migrations/20261009120000_beta_spending_safeguards.sql')
  const fnBody = (sql, name) => {
    const start = sql.indexOf(`create or replace function ${name}`)
    return sql.slice(start, sql.indexOf('$$;', sql.indexOf('as $$', start) + 5))
  }

  it('D-10 FIXED: 20261014120000_invite_ends_at.sql replaces redeem_sponsor_invite with an ends_at check before any insert or use count', () => {
    const body = fnBody(spending, 'public.redeem_sponsor_invite')
    expect(body).not.toMatch(/v_inv\.ends_at\s*(<=|<|>=|>)/) // the original still lacks it; the later migration wins
    const fixed = fnBody(read('supabase/migrations/20261014120000_invite_ends_at.sql'), 'public.redeem_sponsor_invite')
    const at = fixed.indexOf("v_inv.ends_at is not null and v_inv.ends_at <= now() then return jsonb_build_object('status', 'expired')")
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(fixed.indexOf('insert into public.sponsored_accounts'))
    expect(at).toBeLessThan(fixed.indexOf('set uses = uses + 1'))
    expect(at).toBeGreaterThan(fixed.indexOf("return jsonb_build_object('status', 'revoked')"))
    for (const f of ['20261010120000_digest_write_guard', '20261010130000_scheduler_hold', '20261012180000_spend_release']) {
      expect(read(`supabase/migrations/${f}.sql`)).not.toMatch(/function public\.redeem_sponsor_invite/)
    }
  })

  it('D-10b (low): revoking an invite only blocks new redemptions; accounts already enrolled from it keep their caps and end date', () => {
    const body = fnBody(spending, 'public.redeem_sponsor_invite')
    expect(body).toMatch(/v_inv\.revoked_at is not null then return jsonb_build_object\('status', 'inactive'\)/)
    expect(spending).not.toMatch(/update public\.sponsored_accounts[^;]*revoked/i)
  })

  it('D-11 FIXED: 20261014123000_evidence_cache_column_grants.sql replaces the table-wide read with named columns that leave created_by out', () => {
    expect(spending).toMatch(/grant select on public\.evidence_cache_trusted to authenticated;/) // the original grant, since revoked
    const grants = read('supabase/migrations/20261014123000_evidence_cache_column_grants.sql')
    for (const table of ['evidence_cache_trusted', 'evidence_cache']) {
      expect(grants).toMatch(new RegExp(`revoke select on public\\.${table} from authenticated;`))
      const cols = grants.match(new RegExp(`grant select \\(([^)]*)\\)\\s+on public\\.${table} to authenticated;`))?.[1]
      expect(cols).toBeTruthy()
      expect(cols).not.toMatch(/created_by/)
      expect(cols).toMatch(/\bextraction\b/)
    }
    expect(read('src/pipeline/evidenceCache.js')).not.toMatch(/select\('\*'\)/)
  })

  it('D-12 FIXED: supabase/config.toml pins verify_jwt per function, so a plain `functions deploy` reproduces the live gateway settings', () => {
    expect(existsSync(root('supabase/config.toml'))).toBe(true)
    const toml = read('supabase/config.toml')
    const pin = (fn) => toml.match(new RegExp(`\\[functions\\.${fn}\\][^\\[]*verify_jwt = (true|false)`))?.[1]
    expect(['model', 'digest-run', 'redeem-invite', 'match-npi'].map(pin)).toEqual(['false', 'false', 'false', 'false'])
    expect(pin('gmail-canonical-otp')).toBe('true')
    expect(read('docs/SPONSORED_ACCESS_DEPLOY.md')).toMatch(/config\.toml/)
  })

  it('D-13 (medium): the Gmail alias answer is suppressed only for the canonical spelling; any dotted or +tagged probe of a stored inbox confirms an account', () => {
    const prepare = read('supabase/migrations/20261013120000_gmail_alias_prepare.sql')
    expect(prepare).toMatch(/if v_stored is null or v_raw = v_canon then/)
    expect(prepare).toMatch(/grant execute on function public\.gmail_alias_prepare\(text\) to anon, authenticated, service_role;/)
    // Rate limits: 3 per inbox and 8 per address per hour, buckets never pruned, shared "ip:unknown".
    expect(prepare).toMatch(/v_email_count > 3 or v_ip_count > 8/)
    expect(prepare).toMatch(/coalesce\(v_ip, 'unknown'\)/)
    expect(`${prepare}${read('supabase/migrations/20261013050000_gmail_alias_hint_audit.sql')}`).not.toMatch(/delete from private\.gmail_alias_limits/)
  })

  it('D-14 (medium): the digest write guard refuses every browser change except openedAt while a scheduler digest is unfinished, with no check that the sponsorship or the schedule is still alive', () => {
    const guard = read('supabase/migrations/20261010120000_digest_write_guard.sql')
    expect(guard).toMatch(/digest_stale:scheduler_in_flight/)
    expect(guard).toMatch(/v_in_flight := o ->> 'runBy' = 'scheduler'/)
    expect(guard).not.toMatch(/sponsored_accounts/)
  })

  it('D-15 (low): scheduler_kv_write fences the claim but allows any collection except papers', () => {
    expect(spending).toMatch(/if p_collection = 'papers' then raise exception/)
    expect(spending).not.toMatch(/p_collection not in/)
  })
})
