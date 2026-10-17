// The scheduled digest's handler (supabase/functions/digest-run/handler.js) against an
// in-memory database that mirrors the claim/fence RPC contract, with the REAL app facades
// (store.js, anthropic.js, evidenceCache.js) bound per request through AsyncLocalStorage —
// the same mechanism index.ts uses on Deno. The SQL behavior itself is proven against
// PostgreSQL in supabase/tests/; this file proves the handler and the isolation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import Anthropic from '@anthropic-ai/sdk'
import { handleDigestRun, fencedStore, orderByAttempt, attemptsToday, ATTEMPTS_PER_DAY } from '../../supabase/functions/digest-run/handler.js'
import { checkPaidRequest, requestFingerprint } from '../../supabase/functions/_shared/requestPolicy.js'
import { installServerScope, serverRunUnresolved } from './serverScope.js'
import { store, getProfile } from './store.js'
import { getClient, MODELS, accessMode } from './anthropic.js'
import { storeCachedExtraction } from '../pipeline/evidenceCache.js'
import { makeSupabaseStore } from './storeSupabase.js'
import { fakeProvider } from './spendingFakes.js'
import { makeRpcLedger } from '../../supabase/functions/_shared/spending.js'

const HASH = 'e'.repeat(64)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const als = new AsyncLocalStorage()

beforeAll(() => installServerScope(() => als.getStore() ?? null))
afterAll(() => installServerScope(null))

// --- an in-memory database with the claim/fence semantics of the migration --------------
function memoryDb({ users = ['A', 'B'], failRpc = {} } = {}) {
  const t = {
    digest_schedules: users.map((u) => ({ user_id: u, enabled: true, hour_local: 0, timezone: 'UTC', claimed_at: null, claim_token: null, last_run_at: null, last_result: null, last_attempt_at: null, attempt_day: null, attempts_today: 0 })),
    sponsored_accounts: users.map((u) => ({ user_id: u, active: true, ends_at: null })),
    kv: users.map((u) => ({ user_id: u, collection: 'profile', key: 'me', value: { onboarded: true, name: u } })),
    evidence_cache_trusted: [],
    events: [],
    reservations: [],
  }
  let tokens = 0
  const rpcCalls = []
  const rpcs = {
    spend_status: () => ({ allowed: true, reason: null }),
    // spend_reserve's claim contract: a scheduler attempt must present the current token,
    // and admission renews the lease (same transaction in SQL).
    spend_reserve: (a) => {
      const dup = t.reservations.find((r) => r.user_id === a.p_user_id && r.request_id === a.p_request_id)
      if (dup) return { status: dup.fingerprint === a.p_fingerprint ? 'duplicate' : 'mismatch' }
      if (a.p_source === 'scheduler') {
        const row = t.digest_schedules.find((r) => r.user_id === a.p_user_id && r.claim_token && r.claim_token === a.p_claim_token)
        if (!row) return { status: 'denied', reason: 'claim_lost' }
        row.claimed_at = new Date().toISOString()
      }
      const id = `res-${t.reservations.length + 1}`
      t.reservations.push({ id, user_id: a.p_user_id, request_id: a.p_request_id, fingerprint: a.p_fingerprint, source: a.p_source, purpose: a.p_purpose, claim_token: a.p_claim_token, state: 'reserved' })
      return { status: 'reserved', reservation_id: id }
    },
    spend_settle: (a) => { const r = t.reservations.find((x) => x.id === a.p_reservation_id); r.state = 'settled'; r.actual = a.p_actual_micro; return { status: 'settled' } },
    spend_mark_ambiguous: (a) => { const r = t.reservations.find((x) => x.id === a.p_reservation_id); r.state = 'ambiguous'; return { status: 'ambiguous' } },
    spend_release: (a) => {
      const r = t.reservations.find((x) => x.id === a.p_reservation_id)
      if (!r) return { status: 'not_found' }
      if (r.state === 'released') return { status: 'already_released' }
      if (r.state !== 'reserved') return { status: 'unchanged', state: r.state }
      r.state = 'released'
      r.actual = 0
      return { status: 'released' }
    },
    digest_claim: ({ p_user_id, p_stale_seconds }) => {
      const row = t.digest_schedules.find((r) => r.user_id === p_user_id && r.enabled)
      if (!row) return null
      if (row.claimed_at && Date.now() - Date.parse(row.claimed_at) < p_stale_seconds * 1000) return null
      row.claimed_at = new Date().toISOString()
      row.claim_token = `tok-${++tokens}`
      return row.claim_token
    },
    // Every finish stamps the attempt (20261014121000_digest_attempts.sql): last_attempt_at,
    // and attempts_today reset on the first finish of a new local day.
    digest_claim_finish: ({ p_user_id, p_token, p_finished, p_result }) => {
      const row = t.digest_schedules.find((r) => r.user_id === p_user_id && r.claim_token === p_token)
      if (!row) return false
      const now = new Date()
      const day = now.toISOString().slice(0, 10)
      Object.assign(row, {
        claimed_at: null, claim_token: null,
        ...(p_finished ? { last_run_at: now.toISOString() } : {}), ...(p_result ? { last_result: p_result } : {}),
        last_attempt_at: now.toISOString(), attempts_today: row.attempt_day === day ? (row.attempts_today || 0) + 1 : 1, attempt_day: day,
      })
      return true
    },
    // A claim taken but not used: cleared, nothing stamped.
    digest_claim_release: ({ p_user_id, p_token }) => {
      const row = t.digest_schedules.find((r) => r.user_id === p_user_id && r.claim_token === p_token)
      if (!row) return false
      Object.assign(row, { claimed_at: null, claim_token: null })
      return true
    },
    scheduler_kv_write: ({ p_user_id, p_token, p_collection, p_key, p_value, p_delete }) => {
      if (p_collection === 'papers') throw new Error('the scheduler never writes library papers')
      const row = t.digest_schedules.find((r) => r.user_id === p_user_id && r.claim_token === p_token)
      if (!row) return false
      const i = t.kv.findIndex((r) => r.user_id === p_user_id && r.collection === p_collection && r.key === p_key)
      if (p_delete) { if (i >= 0) t.kv.splice(i, 1) } else if (i >= 0) t.kv[i].value = p_value
      else t.kv.push({ user_id: p_user_id, collection: p_collection, key: p_key, value: p_value })
      row.claimed_at = new Date().toISOString()
      return true
    },
  }
  const from = (table) => {
    const filters = []
    let op = 'select'
    let payload = null
    const rows = () => t[table].filter((r) => filters.every((f) => f(r)))
    const chain = {
      select: () => chain,
      eq: (k, v) => { filters.push((r) => r[k] === v); return chain },
      in: (k, vs) => { filters.push((r) => vs.includes(r[k])); return chain },
      is: (k, v) => { filters.push((r) => (r[k] ?? null) === v); return chain },
      order: () => chain,
      range: async () => ({ data: rows().map((r) => ({ value: r.value, key: r.key })), error: null }),
      maybeSingle: async () => { await sleep(1); return { data: rows()[0] ?? null, error: null } },
      update: (p) => { op = 'update'; payload = p; return chain },
      insert: (row) => { t[table].push(row); return Promise.resolve({ error: null }) },
      upsert: (row) => { t[table].push(row); return Promise.resolve({ error: null }) },
      then: (res, rej) => {
        if (op === 'update') { for (const r of rows()) Object.assign(r, payload); return Promise.resolve({ error: null }).then(res, rej) }
        return sleep(1).then(() => ({ data: rows(), error: null })).then(res, rej)
      },
    }
    return chain
  }
  const admin = {
    from,
    rpc: async (name, args) => {
      rpcCalls.push(name)
      await sleep(1)
      if (failRpc[name]) return { data: null, error: new Error(`${name} unavailable`) }
      return { data: rpcs[name](args), error: null }
    },
  }
  return { admin, t, rpcCalls }
}

// A run that drives the real facades with awaits between every step.
async function facadeRun() {
  const profile = await getProfile()
  await sleep(Math.random() * 10)
  const res = await getClient().messages.create({ model: MODELS.fast, max_tokens: 16, messages: [{ role: 'user', content: `paper for ${profile.name}` }] })
  await sleep(Math.random() * 10)
  await store.put('digests', 'daily:latest', { owner: profile.name, mode: accessMode(), msg: res.id, runBy: 'scheduler', server: { phase: 'done' }, results: [] })
  await storeCachedExtraction({ pmid: `pmid-${profile.name}`, hash: HASH, tier: 'full_text', extraction: { study_id: `pmid-${profile.name}`, design: 'other', quantities: [], result_contexts: [] }, model: MODELS.extraction })
  return { phase: 'done', papers: 0, read: 1 }
}

const PROV = { writer: 'digest-run', bundle_source_sha256: 'b'.repeat(64) }

function deps(db, { ledger = makeRpcLedger(db.admin), provider = fakeProvider((n) => ({ body: { id: `msg_${n}`, type: 'message', role: 'assistant', model: MODELS.fast, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } } })), run = facadeRun, user = null } = {}) {
  return {
    ledger,
    provider,
    deps: {
      cronSecret: 'cron',
      getUser: async () => user,
      admin: db.admin,
      ledger,
      dispatch: provider.dispatch,
      app: { makeSupabaseStore, schedulerMayRun: () => true, runDailyDigest: run },
      makeClient: (fetch) => new Anthropic({ apiKey: 'sponsor-guarded', fetch, maxRetries: 0 }),
      runInScope: (scope, fn) => als.run(scope, fn),
      provenance: PROV,
    },
  }
}
const cron = () => new Request('https://fn/digest-run', { method: 'POST', headers: { 'x-cron-secret': 'cron' } })
const manual = () => new Request('https://fn/digest-run', { method: 'POST', headers: { authorization: 'Bearer u' }, body: '{}' })

describe('account isolation', () => {
  it('two accounts interleaved at every await keep their own storage, spend and cache attribution', async () => {
    const db = memoryDb()
    const h = deps(db)
    const [r1, r2] = await Promise.all([handleDigestRun(cron(), h.deps), handleDigestRun(cron(), h.deps)])
    const bodies = [await r1.json(), await r2.json()]
    expect(bodies.map((b) => b.user_id).sort()).toEqual(['A', 'B'])
    for (const u of ['A', 'B']) {
      const latest = db.t.kv.find((r) => r.user_id === u && r.key === 'daily:latest').value
      expect(latest).toMatchObject({ owner: u, mode: 'server' })
      expect(db.t.evidence_cache_trusted.find((r) => r.pmid === `pmid-${u}`)).toMatchObject({ created_by: u, extraction: { format: 'extraction-wire-v2', value: { study_id: `pmid-${u}` } }, provenance: { writer: 'digest-run' } })
    }
    // Each provider attempt was reserved against the account whose prompt it carried.
    expect(h.provider.sent).toHaveLength(2)
    for (const sent of h.provider.sent) {
      const owner = sent.messages[0].content.split(' ').pop()
      const fp = await requestFingerprint(checkPaidRequest(sent).forwardText, 'scheduled-digest')
      expect(db.t.reservations.find((r) => r.fingerprint === fp).user_id).toBe(owner)
    }
    expect(db.t.reservations.every((r) => r.state === 'settled' && r.source === 'scheduler' && r.claim_token)).toBe(true)
    expect(db.t.digest_schedules.every((r) => r.claim_token === null && r.last_run_at)).toBe(true)
  })

  it('positive control: the old module-global binding leaks across interleaved accounts', async () => {
    let current = null
    installServerScope(() => current)
    try {
      const db = memoryDb()
      const h = deps(db)
      h.deps.runInScope = (scope, fn) => { current = scope; return fn() }
      await Promise.all([handleDigestRun(cron(), h.deps), handleDigestRun(cron(), h.deps)])
      const owners = ['A', 'B'].map((u) => db.t.kv.find((r) => r.user_id === u && r.key === 'daily:latest')?.value?.owner)
      expect(owners).not.toEqual(['A', 'B'])
    } finally {
      installServerScope(() => als.getStore() ?? null)
    }
  })

  it('outside a scope, the facades refuse instead of using any account', async () => {
    await expect(Promise.resolve().then(() => store.get('profile', 'me'))).rejects.toThrow(/outside an account scope/)
    expect(() => getClient()).toThrow(/outside an account scope/)
    expect(() => accessMode()).toThrow(/outside an account scope/)
  })
})

describe('claims', () => {
  it('two overlapping runs for one account: exactly one runs', async () => {
    const db = memoryDb({ users: ['A'] })
    let runs = 0
    const h = deps(db, { user: { id: 'A' }, run: async () => { runs++; await sleep(30); return { phase: 'done', papers: 0, read: 0 } } })
    const [r1, r2] = await Promise.all([handleDigestRun(manual(), h.deps), handleDigestRun(manual(), h.deps)])
    const out = [await r1.json(), await r2.json()]
    expect(runs).toBe(1)
    expect(out.filter((o) => o.ran)).toHaveLength(1)
    expect(out.find((o) => !o.ran).reason).toBe('already running')
  })
  it('cron and a manual run race for one account: exactly one runs and exactly one paid request goes out', async () => {
    const db = memoryDb({ users: ['A'] })
    let runs = 0
    const h = deps(db, { user: { id: 'A' }, run: async () => { runs++; await sleep(30); return facadeRun() } })
    await Promise.all([handleDigestRun(cron(), h.deps), handleDigestRun(manual(), h.deps)])
    expect(runs).toBe(1)
    expect(h.provider.sent).toHaveLength(1)
    expect(db.t.reservations).toHaveLength(1)
  })

  // Codex review reproduction (2026-10-09), inverted: the claim is replaced just before the
  // stale worker's next paid call. It must make ZERO provider requests.
  it('a stale claim cannot dispatch a paid request', async () => {
    const db = memoryDb({ users: ['A'] })
    const h = deps(db, { run: async () => {
      db.t.digest_schedules[0].claim_token = 'successor-token'
      await getClient().messages.create({ model: MODELS.fast, max_tokens: 16, messages: [{ role: 'user', content: 'stale worker' }] })
      return { phase: 'done', papers: 0, read: 0 }
    } })
    const out = await (await handleDigestRun(cron(), h.deps)).json()
    expect(h.provider.sent).toHaveLength(0)
    expect(db.t.reservations).toHaveLength(0)
    expect(out.claimLost).toBe(true)
    expect(out.spend).toMatchObject({ dispatched: 0, halted: 'claim_lost', outcomes: ['claim_lost'] })
    expect(db.t.digest_schedules[0].claim_token).toBe('successor-token')
  })

  it('an admitted slow attempt renews the lease, so a takeover during it is refused', async () => {
    const db = memoryDb({ users: ['A'] })
    let release
    const gate = new Promise((r) => { release = r })
    const provider = fakeProvider(() => ({ body: { id: 'msg_slow', type: 'message', role: 'assistant', model: MODELS.fast, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }))
    const slowDispatch = async (...a) => { await gate; return provider.dispatch(...a) }
    let second
    const h = deps(db, { run: async () => {
      // The worker has been quiet long enough for its claim to look stale...
      db.t.digest_schedules[0].claimed_at = new Date(Date.now() - 10 * 60_000).toISOString()
      const call = getClient().messages.create({ model: MODELS.fast, max_tokens: 16, messages: [{ role: 'user', content: 'slow' }] })
      // ...but admitting this attempt renewed it, so a tick arriving mid-call cannot take over.
      await sleep(20)
      second = await (await handleDigestRun(cron(), { ...h.deps, dispatch: provider.dispatch })).json()
      release()
      await call
      return { phase: 'done', papers: 0, read: 1 }
    } })
    h.deps.dispatch = slowDispatch
    const first = await (await handleDigestRun(cron(), h.deps)).json()
    expect(second).toMatchObject({ ran: false, reason: 'already running' })
    expect(first).toMatchObject({ ran: true, claimLost: false })
    expect(provider.sent).toHaveLength(1)
  })

  it('after a takeover, the old worker\'s retry is refused without dispatch', async () => {
    const db = memoryDb({ users: ['A'] })
    const h = deps(db, { run: async () => {
      await getClient().messages.create({ model: MODELS.fast, max_tokens: 16, messages: [{ role: 'user', content: 'first' }] })
      db.t.digest_schedules[0].claim_token = 'successor-token'
      for (let i = 0; i < 3; i++) await getClient().messages.create({ model: MODELS.fast, max_tokens: 16, messages: [{ role: 'user', content: `retry ${i}` }] }).catch(() => {})
      return { phase: 'done', papers: 0, read: 1 }
    } })
    const out = await (await handleDigestRun(cron(), h.deps)).json()
    expect(h.provider.sent.map((b) => b.messages[0].content)).toEqual(['first'])
    expect(db.t.reservations).toHaveLength(1)
    expect(out.spend.halted).toBe('claim_lost')
    expect(out.claimLost).toBe(true)
  })
  it('a stale owner cannot overwrite its successor or clear its claim', async () => {
    const db = memoryDb({ users: ['A'] })
    const h = deps(db, {
      run: async () => {
        await store.put('digests', 'daily:latest', { v: 'first write', runBy: 'scheduler', server: { phase: 'reading' } })
        // This worker stalls; the claim goes stale and a successor takes over and writes.
        const row = db.t.digest_schedules[0]
        row.claim_token = 'successor'
        db.t.kv.find((r) => r.key === 'daily:latest').value = { v: 'successor' }
        await store.put('digests', 'daily:latest', { v: 'stale overwrite' })
        return { phase: 'done', papers: 0, read: 0 }
      },
    })
    const out = await (await handleDigestRun(cron(), h.deps)).json()
    expect(out.phase).toBe('error')
    expect(out.note).toMatch(/claim lost/)
    expect(out.claimLost).toBe(true)
    expect(db.t.kv.find((r) => r.key === 'daily:latest').value).toEqual({ v: 'successor' })
    expect(db.t.digest_schedules[0].claim_token).toBe('successor')
  })
  it('a failed claim RPC stops before any work', async () => {
    const db = memoryDb({ users: ['A'], failRpc: { digest_claim: true } })
    let runs = 0
    const res = await handleDigestRun(cron(), deps(db, { run: async () => { runs++ } }).deps)
    expect(res.status).toBe(503)
    expect(runs).toBe(0)
  })
  it('a failed spending preflight stops before claiming', async () => {
    const db = memoryDb({ users: ['A'], failRpc: { spend_status: true } })
    const res = await handleDigestRun(cron(), deps(db, { run: async () => { throw new Error('must not run') } }).deps)
    expect(res.status).toBe(503)
    expect(db.rpcCalls).not.toContain('digest_claim')
  })
  it('an account whose spending is stopped is skipped without a claim', async () => {
    const db = memoryDb({ users: ['A'] })
    db.admin.rpc = ((orig) => async (name, args) => (name === 'spend_status' ? { data: { allowed: false, reason: 'spending_paused' }, error: null } : orig(name, args)))(db.admin.rpc)
    const out = await (await handleDigestRun(cron(), deps(db).deps)).json()
    expect(out).toMatchObject({ ran: false, reason: 'spending stopped: spending_paused' })
    expect(db.t.digest_schedules[0]).toMatchObject({ claim_token: null, last_result: 'skipped: spending_paused' })
  })
  it('re-checks the gate after claiming and releases the claim if another tick already finished', async () => {
    const db = memoryDb({ users: ['A'] })
    let runs = 0
    // Between the gate read and the claim, another tick saved today's digest.
    db.admin.rpc = ((orig) => async (name, args) => {
      if (name === 'digest_claim') db.t.kv.push({ user_id: 'A', collection: 'digests', key: 'daily:latest', value: { results: [{}], ranAt: new Date().toISOString(), runBy: 'scheduler', server: { phase: 'done' } } })
      return orig(name, args)
    })(db.admin.rpc)
    const out = await (await handleDigestRun(cron(), deps(db, { run: async () => { runs++ } }).deps)).json()
    expect(runs).toBe(0)
    expect(out.ran).toBe(false)
    expect(db.t.digest_schedules[0].claim_token).toBeNull()
  })
  it('unauthenticated manual calls are refused', async () => {
    expect((await handleDigestRun(manual(), deps(memoryDb()).deps)).status).toBe(401)
  })

  it('a manual run provisions an enabled schedule when a sponsored account has none', async () => {
    const db = memoryDb({ users: ['A'] })
    db.t.digest_schedules.length = 0
    const req = new Request('https://fn/digest-run', { method: 'POST', headers: { authorization: 'Bearer u' }, body: JSON.stringify({ timezone: 'America/Los_Angeles' }) })
    const out = await (await handleDigestRun(req, deps(db, { user: { id: 'A' }, run: async () => ({ phase: 'done', papers: 1, read: 1 }) }).deps)).json()
    expect(out).toMatchObject({ ran: true, phase: 'done', user_id: 'A' })
    expect(db.t.digest_schedules).toEqual([expect.objectContaining({ user_id: 'A', enabled: true, hour_local: 6, timezone: 'America/Los_Angeles' })])
  })

  it('a manual run falls back to New York when the timezone is not real', async () => {
    const db = memoryDb({ users: ['A'] })
    db.t.digest_schedules.length = 0
    const req = new Request('https://fn/digest-run', { method: 'POST', headers: { authorization: 'Bearer u' }, body: JSON.stringify({ timezone: 'Not/AZone' }) })
    const out = await (await handleDigestRun(req, deps(db, { user: { id: 'A' }, run: async () => ({ phase: 'empty', papers: 0, read: 0 }) }).deps)).json()
    expect(out.ran).toBe(true)
    expect(db.t.digest_schedules[0].timezone).toBe('America/New_York')
  })

  it('cron does not invent a schedule, and a manual run does not sponsor someone or turn a schedule back on', async () => {
    const bare = memoryDb({ users: ['A'] })
    bare.t.digest_schedules.length = 0
    expect(await (await handleDigestRun(cron(), deps(bare).deps)).json()).toMatchObject({ ran: false, reason: 'nothing due' })
    expect(bare.t.digest_schedules).toHaveLength(0)

    const outsider = memoryDb({ users: ['A'] })
    outsider.t.digest_schedules.length = 0
    outsider.t.sponsored_accounts.length = 0
    expect(await (await handleDigestRun(manual(), deps(outsider, { user: { id: 'A' } }).deps)).json()).toMatchObject({ ran: false, reason: 'nothing due' })
    expect(outsider.t.digest_schedules).toHaveLength(0)

    const off = memoryDb({ users: ['A'] })
    off.t.digest_schedules[0].enabled = false
    expect(await (await handleDigestRun(manual(), deps(off, { user: { id: 'A' }, run: async () => { throw new Error('must not run') } }).deps)).json()).toMatchObject({ ran: false, reason: 'nothing due' })
    expect(off.t.digest_schedules).toEqual([expect.objectContaining({ user_id: 'A', enabled: false })])
  })
})

describe('holds', () => {
  // A 2xx we cannot price is still a hold. A provider error releases the dollar hold
  // and is covered separately below.
  const failing = () => fakeProvider({
    status: 200,
    body: { id: 'msg_x', type: 'message', role: 'assistant', model: MODELS.fast, content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' },
  })
  const attempt = () => getClient().messages.create({ model: MODELS.fast, max_tokens: 16, messages: [{ role: 'user', content: 'x' }] })

  it('an ambiguous attempt is visible to the runner, and a held tick neither finishes the day nor reports an error', async () => {
    const db = memoryDb({ users: ['A'] })
    let seen = 'unset'
    const run = async () => {
      await attempt().catch(() => {})
      seen = serverRunUnresolved()
      return { phase: 'held', papers: 0, read: 0, note: 'held' }
    }
    const out = await (await handleDigestRun(cron(), deps(db, { run, provider: failing() }).deps)).json()
    expect(seen).toBe('ambiguous')
    expect(out).toMatchObject({ ran: true, phase: 'held', spend: { dispatched: 1, halted: 'ambiguous', unresolved: 'ambiguous' } })
    expect(db.t.digest_schedules[0]).toMatchObject({ claim_token: null, last_run_at: null })
    expect(db.t.digest_schedules[0].last_result).toMatch(/^held:/)
    expect(db.t.events.at(-1).payload).toMatchObject({ phase: 'held', spend: { unresolved: 'ambiguous' } })
  })

  it('a run that throws after an unresolved attempt is reported as held, never as an error that will retry', async () => {
    const db = memoryDb({ users: ['A'] })
    const run = async () => { await attempt().catch(() => {}); throw new Error('save failed') }
    const out = await (await handleDigestRun(cron(), deps(db, { run, provider: failing() }).deps)).json()
    expect(out.phase).toBe('held')
    expect(out.note).toMatch(/held for operator review\. \(save failed\)/)
    expect(db.t.digest_schedules[0].last_run_at).toBeNull()
  })

  it('a digest that genuinely finished stays finished; the unresolved attempt is still reported', async () => {
    const db = memoryDb({ users: ['A'] })
    const run = async () => { await attempt().catch(() => {}); return { phase: 'done', papers: 2, read: 2 } }
    const out = await (await handleDigestRun(cron(), deps(db, { run, provider: failing() }).deps)).json()
    expect(out).toMatchObject({ phase: 'done', spend: { unresolved: 'ambiguous' } })
    expect(db.t.digest_schedules[0].last_run_at).not.toBeNull()
  })

  it('a release that comes back unchanged stops the run and keeps the hold', async () => {
    const db = memoryDb({ users: ['A'] })
    const orig = db.admin.rpc
    db.admin.rpc = async (name, args) => (name === 'spend_release' ? { data: { status: 'unchanged', state: 'reserved' }, error: null } : orig(name, args))
    const provider = fakeProvider({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'no' } } })
    let seen = 'unset'
    const run = async () => {
      await attempt().catch(() => {})
      seen = serverRunUnresolved()
      return { phase: 'reading', papers: 0, read: 0 }
    }
    const out = await (await handleDigestRun(cron(), deps(db, { run, provider }).deps)).json()
    expect(seen).toBe('release_failed')
    expect(out.phase).toBe('held')
    expect(out.spend).toMatchObject({ dispatched: 1, halted: 'release_failed', unresolved: 'release_failed' })
    expect(db.t.reservations.map((r) => r.state)).toEqual(['reserved'])
    expect(db.t.digest_schedules[0].last_run_at).toBeNull()
    expect(provider.sent).toHaveLength(1)
  })

  it('a provider error releases the hold and does not freeze the run', async () => {
    const db = memoryDb({ users: ['A'] })
    const provider = fakeProvider({ status: 500, body: { type: 'error', error: { type: 'api_error', message: 'fake provider failure' } } })
    let seen = 'unset'
    const run = async () => {
      await attempt().catch(() => {})
      seen = serverRunUnresolved()
      return { phase: 'reading', papers: 1, read: 1 }
    }
    const out = await (await handleDigestRun(cron(), deps(db, { run, provider }).deps)).json()
    expect(seen).toBeNull()
    expect(out).toMatchObject({ phase: 'reading', spend: { dispatched: 1, halted: null, unresolved: null } })
    expect(db.t.reservations.map((r) => r.state)).toEqual(['released'])
    expect(provider.sent).toHaveLength(1)
  })

  it('a refusal before dispatch (cap) is not an unresolved attempt', async () => {
    const db = memoryDb({ users: ['A'] })
    db.admin.rpc = ((orig) => async (name, args) => (name === 'spend_reserve' ? { data: { status: 'denied', reason: 'cap_day' }, error: null } : orig(name, args)))(db.admin.rpc)
    let seen = 'unset'
    const run = async () => { await attempt().catch(() => {}); seen = serverRunUnresolved(); return { phase: 'capped', papers: 0, read: 0 } }
    const out = await (await handleDigestRun(cron(), deps(db, { run }).deps)).json()
    expect(seen).toBeNull()
    expect(out).toMatchObject({ phase: 'capped', spend: { dispatched: 0, unresolved: null } })
  })

  it('a held account is skipped by cron and by a manual run before any claim or work', async () => {
    for (const request of [cron, manual]) {
      const db = memoryDb({ users: ['A'] })
      db.admin.rpc = ((orig) => async (name, args) => (name === 'spend_status' ? { data: { allowed: false, reason: 'unresolved_liability' }, error: null } : orig(name, args)))(db.admin.rpc)
      const d = deps(db, { run: async () => { throw new Error('must not run') }, user: { id: 'A' } })
      const out = await (await handleDigestRun(request(), d.deps)).json()
      expect(out).toMatchObject({ ran: false, reason: 'spending stopped: unresolved_liability' })
      expect(db.rpcCalls).not.toContain('digest_claim')
      expect(d.provider.sent).toHaveLength(0)
    }
  })
})

describe('fairness across the cohort', () => {
  const today = new Date().toISOString().slice(0, 10)
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()

  it('orders never-attempted accounts first, then least recently attempted, keeping database order on ties', () => {
    const rows = [{ user_id: 'C', last_attempt_at: ago(5) }, { user_id: 'A', last_attempt_at: ago(60) }, { user_id: 'N1', last_attempt_at: null }, { user_id: 'N2' }, { user_id: 'B', last_attempt_at: ago(60) }]
    expect(orderByAttempt(rows).map((r) => r.user_id)).toEqual(['N1', 'N2', 'A', 'B', 'C'])
    expect(orderByAttempt(undefined)).toEqual([])
  })

  it('counts today\'s attempts only in the account\'s own day', () => {
    const now = new Date('2026-10-14T12:00:00Z')
    expect(attemptsToday({ timezone: 'UTC', attempt_day: '2026-10-14', attempts_today: 4 }, now)).toBe(4)
    expect(attemptsToday({ timezone: 'UTC', attempt_day: '2026-10-13', attempts_today: 4 }, now)).toBe(0)
    // 12:00 UTC is still 13 October in Honolulu? No: it is 02:00 on the 14th. In Auckland it is 01:00 on the 15th.
    expect(attemptsToday({ timezone: 'Pacific/Auckland', attempt_day: '2026-10-14', attempts_today: 4 }, now)).toBe(0)
    expect(attemptsToday({ timezone: 'Pacific/Auckland', attempt_day: '2026-10-15', attempts_today: 4 }, now)).toBe(4)
    expect(attemptsToday({ timezone: 'UTC', attempt_day: null, attempts_today: 9 }, now)).toBe(0)
    expect(attemptsToday(null, now)).toBe(0)
  })

  it('a cron tick stamps every finish, errors included, and the failing account goes to the back of the queue', async () => {
    const db = memoryDb({ users: ['A', 'B'] })
    const h = deps(db, { run: async () => { throw new Error('boom') } })
    const first = await (await handleDigestRun(cron(), h.deps)).json()
    expect(first).toMatchObject({ ran: true, user_id: 'A', phase: 'error' })
    const a = db.t.digest_schedules.find((r) => r.user_id === 'A')
    expect(a.last_attempt_at).toBeTruthy()
    expect(a).toMatchObject({ attempts_today: 1, attempt_day: today, last_run_at: null })
    const second = await (await handleDigestRun(cron(), h.deps)).json()
    expect(second).toMatchObject({ ran: true, user_id: 'B', phase: 'error' })
    const third = await (await handleDigestRun(cron(), h.deps)).json()
    expect(third.user_id).toBe('A')
    expect(db.t.digest_schedules.find((r) => r.user_id === 'A').attempts_today).toBe(2)
  })

  it('a claim released after the post-claim re-check is not an attempt', async () => {
    const db = memoryDb({ users: ['A'] })
    db.admin.rpc = ((orig) => async (name, args) => {
      if (name === 'digest_claim') db.t.kv.push({ user_id: 'A', collection: 'digests', key: 'daily:latest', value: { results: [{}], ranAt: new Date().toISOString(), runBy: 'scheduler', server: { phase: 'done' } } })
      return orig(name, args)
    })(db.admin.rpc)
    const out = await (await handleDigestRun(cron(), deps(db, { run: async () => { throw new Error('must not run') } }).deps)).json()
    expect(out.ran).toBe(false)
    expect(db.rpcCalls).toContain('digest_claim_release')
    expect(db.rpcCalls).not.toContain('digest_claim_finish')
    expect(db.t.digest_schedules[0]).toMatchObject({ claim_token: null, last_attempt_at: null, attempts_today: 0 })
  })

  it('an account at the day\'s attempt cap is skipped by cron so the cohort still runs, and reached again on a manual press', async () => {
    const db = memoryDb({ users: ['A', 'B'] })
    Object.assign(db.t.digest_schedules[0], { last_attempt_at: ago(3), attempt_day: today, attempts_today: ATTEMPTS_PER_DAY })
    let ranFor = []
    const h = deps(db, { user: { id: 'A' }, run: async () => { ranFor.push(await getProfile().then((p) => p.name)); return { phase: 'done', papers: 1, read: 1 } } })
    const out = await (await handleDigestRun(cron(), h.deps)).json()
    expect(out).toMatchObject({ ran: true, user_id: 'B' })
    expect(ranFor).toEqual(['B'])
    // With the cohort done for the day, the capped account is the reason, not 'nothing due'.
    db.t.digest_schedules[1].enabled = false
    const again = await (await handleDigestRun(cron(), h.deps)).json()
    expect(again).toMatchObject({ ran: false, reason: 'attempt cap reached' })
    expect(db.rpcCalls.filter((n) => n === 'digest_claim')).toHaveLength(1)
    // The reader's own press is not capped.
    const mine = await (await handleDigestRun(manual(), h.deps)).json()
    expect(mine).toMatchObject({ ran: true, user_id: 'A' })
    expect(db.t.digest_schedules[0].attempts_today).toBe(ATTEMPTS_PER_DAY + 1)
  })

  it('one short of the cap still runs', async () => {
    const db = memoryDb({ users: ['A'] })
    Object.assign(db.t.digest_schedules[0], { attempt_day: today, attempts_today: ATTEMPTS_PER_DAY - 1 })
    const out = await (await handleDigestRun(cron(), deps(db, { run: async () => ({ phase: 'reading', papers: 0, read: 1 }) }).deps)).json()
    expect(out).toMatchObject({ ran: true, user_id: 'A' })
  })

  it('yesterday\'s attempts do not count', async () => {
    const db = memoryDb({ users: ['A'] })
    Object.assign(db.t.digest_schedules[0], { attempt_day: '2000-01-01', attempts_today: 99 })
    const out = await (await handleDigestRun(cron(), deps(db, { run: async () => ({ phase: 'done', papers: 0, read: 0 }) }).deps)).json()
    expect(out).toMatchObject({ ran: true, user_id: 'A' })
    expect(db.t.digest_schedules[0]).toMatchObject({ attempts_today: 1, attempt_day: today })
  })
})

describe('the fenced store', () => {
  it('never writes library papers and never clears', async () => {
    const db = memoryDb({ users: ['A'] })
    const s = fencedStore(makeSupabaseStore({ client: db.admin, userId: 'A' }), { admin: db.admin, userId: 'A', token: 'x' })
    await expect(s.put('papers', '1', {})).rejects.toThrow(/never writes library papers/)
    await expect(s.clear('digests')).rejects.toThrow()
  })
})
