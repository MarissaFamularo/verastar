// Deno-runtime proof that the GENERATED scheduler bundle, driven by the real digest-run
// handler, makes its paid attempts through the reserve/settle boundary with the run's claim
// token, settles each at the exact price, persists through the claim fence, and makes ZERO
// paid attempts once its claim is lost. In-memory database (the claim/fence/reserve contract
// of the migration, minus PostgREST), real makeRpcLedger, real Anthropic SDK, fake provider,
// synthetic data. No network.
//   cd supabase/functions && deno test --no-lock --allow-env --allow-net=127.0.0.1 --config deno.json tests/
// (--allow-env: the Anthropic SDK reads its environment when constructed, as on the edge runtime.)
import { AsyncLocalStorage } from 'node:async_hooks'
import Anthropic from '@anthropic-ai/sdk'
import * as app from '../digest-run/app.bundle.js'
import { handleDigestRun } from '../digest-run/handler.js'
import { makeRpcLedger } from '../_shared/spending.js'
import { SERVER_CLIENT_TIMEOUT_MS } from '../_shared/timeouts.js'
import { profileFixture, rankPhaseDigest, fakeProviderReply, EXPECTED, PAPER_ID } from '../../tests/fixtures/scheduledRankFixture.mjs'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const scopes = new AsyncLocalStorage()
app.installServerScope(() => scopes.getStore() ?? null)

type Row = Record<string, any>

function memoryDb(user: string) {
  const t: Record<string, Row[]> = {
    digest_schedules: [{ user_id: user, enabled: true, hour_local: 0, timezone: 'UTC', claimed_at: null, claim_token: null, last_run_at: null, last_result: null }],
    sponsored_accounts: [{ user_id: user, active: true, ends_at: null }],
    kv: [
      { user_id: user, collection: 'profile', key: 'me', value: profileFixture() },
      { user_id: user, collection: 'digests', key: 'daily:latest', value: rankPhaseDigest() },
    ],
    evidence_cache_trusted: [],
    events: [],
    reservations: [],
  }
  let tokens = 0
  const hooks: Record<string, () => void> = {}
  const rpcs: Record<string, (a: Row) => unknown> = {
    spend_status: () => ({ allowed: true, reason: null }),
    digest_claim: ({ p_user_id, p_stale_seconds }) => {
      const row = t.digest_schedules.find((r) => r.user_id === p_user_id && r.enabled)
      if (!row || (row.claimed_at && Date.now() - Date.parse(row.claimed_at) < p_stale_seconds * 1000)) return null
      row.claimed_at = new Date().toISOString()
      row.claim_token = `tok-${++tokens}`
      return row.claim_token
    },
    digest_claim_finish: ({ p_user_id, p_token, p_finished, p_result }) => {
      const row = t.digest_schedules.find((r) => r.user_id === p_user_id && r.claim_token === p_token)
      if (!row) return false
      Object.assign(row, { claimed_at: null, claim_token: null, ...(p_finished ? { last_run_at: new Date().toISOString() } : {}), ...(p_result ? { last_result: p_result } : {}) })
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
    spend_reserve: (a) => {
      hooks.beforeReserve?.()
      if (a.p_source !== 'scheduler' || !a.p_claim_token) return { status: 'denied', reason: 'claim_lost' }
      const row = t.digest_schedules.find((r) => r.user_id === a.p_user_id && r.claim_token === a.p_claim_token)
      if (!row) return { status: 'denied', reason: 'claim_lost' }
      row.claimed_at = new Date().toISOString()
      const id = `res-${t.reservations.length + 1}`
      t.reservations.push({ id, user_id: a.p_user_id, model: a.p_model, source: a.p_source, purpose: a.p_purpose, reserved: a.p_reserve_micro, token: a.p_claim_token, state: 'reserved' })
      return { status: 'reserved', reservation_id: id }
    },
    spend_settle: (a) => {
      const r = t.reservations.find((x) => x.id === a.p_reservation_id)!
      Object.assign(r, { state: 'settled', actual: a.p_actual_micro, settledModel: a.p_model })
      return { status: 'settled' }
    },
    spend_mark_ambiguous: (a) => { t.reservations.find((x) => x.id === a.p_reservation_id)!.state = 'ambiguous'; return { status: 'ambiguous' } },
  }
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = []
    let op = 'select'
    let payload: Row = {}
    const rows = () => t[table].filter((r) => filters.every((f) => f(r)))
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return chain },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return chain },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return chain },
      order: () => chain,
      range: () => Promise.resolve({ data: rows().map((r) => ({ value: r.value, key: r.key })), error: null }),
      maybeSingle: () => Promise.resolve({ data: structuredClone(rows()[0] ?? null), error: null }),
      update: (p: Row) => { op = 'update'; payload = p; return chain },
      insert: (row: Row) => { t[table].push(row); return Promise.resolve({ error: null }) },
      upsert: (row: Row) => { t[table].push(row); return Promise.resolve({ error: null }) },
      then: (res: any, rej: any) => {
        if (op === 'update') { for (const r of rows()) Object.assign(r, payload); return Promise.resolve({ error: null }).then(res, rej) }
        return Promise.resolve({ data: structuredClone(rows()), error: null }).then(res, rej)
      },
    }
    return chain
  }
  const admin = { from, rpc: async (name: string, args: Row) => ({ data: rpcs[name](args), error: null }) }
  return { admin, t, hooks }
}

function harness(user = 'synthetic-user') {
  const db = memoryDb(user)
  const sent: any[] = []
  const dispatch = async (text: string) => {
    const req = JSON.parse(text)
    sent.push(req)
    const reply = fakeProviderReply(req, sent.length)
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json', 'request-id': `req_fixture_${sent.length}` } })
  }
  const deps = {
    cronSecret: 'cron-secret-for-test',
    getUser: async () => null,
    admin: db.admin,
    app,
    ledger: makeRpcLedger(db.admin),
    dispatch,
    makeClient: (fetch: typeof globalThis.fetch) => new Anthropic({ apiKey: 'sponsor-guarded', fetch, maxRetries: 2, timeout: SERVER_CLIENT_TIMEOUT_MS }),
    runInScope: (scope: unknown, fn: () => Promise<unknown>) => scopes.run(scope, fn),
    provenance: { writer: 'digest-run', bundle_source_sha256: 'b'.repeat(64) },
  }
  const tick = async () => (await handleDigestRun(new Request('https://fn/digest-run', { method: 'POST', headers: { 'x-cron-secret': deps.cronSecret } }), deps)).json()
  return { db, sent, tick }
}

Deno.test('the bundled runner ranks through the boundary: two paid attempts, both settled exactly, claim-bound', async () => {
  const { db, sent, tick } = harness()
  const out = await tick()
  assert(out.ran === true && out.phase === 'done' && out.papers === 1, `unexpected result ${JSON.stringify(out)}`)
  assert(out.claimLost === false && out.spend.dispatched === 2 && out.spend.halted === null, `spend ${JSON.stringify(out.spend)}`)
  assert(sent.map((b) => b.model).join() === [EXPECTED.triage.model, EXPECTED.check.model].join(), `models ${sent.map((b) => b.model)}`)
  const res = db.t.reservations
  assert(res.length === 2 && res.every((r) => r.state === 'settled' && r.source === 'scheduler' && r.token === 'tok-1'), `reservations ${JSON.stringify(res)}`)
  assert(res[0].actual === EXPECTED.triage.micro && res[1].actual === EXPECTED.check.micro, `settled at ${res.map((r) => r.actual)}`)
  assert(res.every((r) => r.reserved >= r.actual), 'every settlement within its reservation')
  const digest = db.t.kv.find((r) => r.key === 'daily:latest')!.value
  assert(digest.server.phase === 'done' && digest.triaged[PAPER_ID].score === 90 && digest.triaged[PAPER_ID].check.verdict === 'supported', `digest ${JSON.stringify(digest.server)}`)
  assert(db.t.kv.some((r) => r.collection === 'seen'), 'seen ledger written through the fence')
  const schedule = db.t.digest_schedules[0]
  assert(schedule.claim_token === null && schedule.last_run_at, 'owner finished and released the claim')
})

Deno.test('a claim lost before the first paid attempt: zero dispatches, nothing reserved, progress kept for the owner', async () => {
  const { db, sent, tick } = harness()
  db.hooks.beforeReserve = () => { db.t.digest_schedules[0].claim_token = 'successor-token' }
  const out = await tick()
  assert(sent.length === 0, `dispatched ${sent.length}`)
  assert(db.t.reservations.length === 0, 'nothing reserved')
  assert(out.claimLost === true && out.spend.halted === 'claim_lost', `spend ${JSON.stringify(out.spend)}`)
  assert(db.t.kv.find((r) => r.key === 'daily:latest')!.value.server.phase === 'rank', 'the stale worker wrote nothing; the run stays resumable')
  assert(db.t.digest_schedules[0].claim_token === 'successor-token', 'successor keeps the claim')
})

Deno.test('a fresh claim held elsewhere: the tick does not run and nothing is dispatched', async () => {
  const { db, sent, tick } = harness()
  Object.assign(db.t.digest_schedules[0], { claimed_at: new Date().toISOString(), claim_token: 'other-worker' })
  const out = await tick()
  assert(out.ran === false && out.reason === 'already running', JSON.stringify(out))
  assert(sent.length === 0 && db.t.reservations.length === 0, 'no paid attempt')
})
