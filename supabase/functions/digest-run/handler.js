import { observeDigest } from '../_shared/observeSignup.js'
// supabase/functions/digest-run/handler.js — the scheduled morning digest, minus the runtime.
//
// index.ts binds this to Deno.serve, Supabase, Anthropic and AsyncLocalStorage; vitest binds
// it to fakes (src/lib/digestRunHandler.test.js). Each call picks at most ONE due sponsored
// account and runs, or continues, its digest with the app's headless runner.
//
// Ownership: a run owns an account only while it holds the claim token returned by the
// atomic digest_claim RPC. Every storage write is fenced by that token in the database
// (scheduler_kv_write), and finishing is owner-guarded (digest_claim_finish), so a stale
// worker can neither overwrite a successor's results nor clear its claim.
//
// Isolation: the account's store, model client and cache writer live in a request scope
// (src/lib/serverScope.js) for the whole run, including all of its asynchronous work; no
// module global names the account.
//
// Spending: the model client's fetch is makeGuardedFetch (../_shared/spending.js): every
// SDK attempt is reserved, dispatched once, and settled, with the same database contract
// as the browser proxy. Each reservation carries the claim token, so a run that has lost
// the account cannot make another paid call (zero dispatches), and the run halts.
//
// Holds: a dispatched attempt that ended without a confirmed cost (ambiguous, or its outcome
// could not be recorded) is noted on the run's scope as it happens. The runner then stops
// without finishing the step or the day (phase 'held'), and the database refuses every later
// scheduler attempt and preflight for the account until an operator reconciles the attempt and
// runs scheduler_recover (supabase/migrations/20261010130000_scheduler_hold.sql). Nothing here
// retries, reconciles or recovers.
//
// Callable two ways: from cron with x-cron-secret, or by a signed-in user ("run mine now"),
// which ignores the hour and the opened gate but keeps the claim and the spending checks.
// A manual run needs a claimable schedule row. Enrollment does not create one, and
// digest_claim only updates an enabled row, so a sponsored account with no row is given
// the table default (on, 6:00, timezone from the request or America/New_York). Cron never
// creates a row, and a row the reader turned off stays off.
//
// Fairness (20261014121000_digest_attempts.sql): every finished run, error included, stamps
// digest_schedules.last_attempt_at, and a cron tick considers accounts in the order
// coalesce(last_attempt_at, 'epoch') ascending, so the account tried most recently waits
// behind everyone else and a never-tried account goes first. A cron tick also skips an
// account that has already finished ATTEMPTS_PER_DAY runs this local day, so one account
// whose run errors every tick cannot occupy the scheduler all morning. A manual run is
// neither reordered (it names one account) nor capped.

import { accountActive, localClock, digestGate, requestedTimezone } from '../model/logic.js'
import { makeGuardedFetch } from '../_shared/spending.js'
import { CLAIM_STALE_SECONDS } from '../_shared/timeouts.js'

// Reading budget per tick. The edge runtime's wall clock is 150 s (free) / 400 s (paid);
// reading stops here so persistence and the handoff still fit.
export const BUDGET_MS = 75_000
// A claim older than CLAIM_STALE_SECONDS belongs to a dead tick. Every fenced write AND
// every admitted paid attempt (spend_reserve with the claim token) renews it, and an
// admitted attempt cannot outlive the provider timeout, which is shorter (timeouts.js).
export { CLAIM_STALE_SECONDS }
// Finished runs (done, empty, error, held, capped...) one account may make per local day
// before cron leaves it alone until its next day. A normal digest finishes in two or three
// ticks; a long one with a fallback read in five or six. A manual run is not counted here.
export const ATTEMPTS_PER_DAY = 12

const HELD_NOTE = 'A paid step ended without a confirmed outcome; the run is held for operator review.'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// The account's storage for this run: reads as usual, writes only through the claim fence.
export function fencedStore(inner, { admin, userId, token }) {
  const write = async (collection, key, value, del) => {
    if (collection === 'papers') throw new Error('The scheduler never writes library papers.')
    const { data, error } = await admin.rpc('scheduler_kv_write', {
      p_user_id: userId, p_token: token, p_collection: collection, p_key: key, p_value: del ? null : value, p_delete: del,
    })
    if (error) throw new Error(`Scheduler write failed: ${error.message || error}`)
    if (data !== true) throw new Error('Scheduler claim lost; this run stops without writing.')
  }
  return {
    get: (collection, key) => inner.get(collection, key),
    all: (collection) => inner.all(collection),
    put: (collection, key, value) => write(collection, key, value, false),
    delete: (collection, key) => write(collection, key, null, true),
    clear: async () => { throw new Error('The scheduler never clears a collection.') },
  }
}

async function readLatest(admin, userId) {
  const { data, error } = await admin.from('kv').select('value').eq('user_id', userId).eq('collection', 'digests').eq('key', 'daily:latest').maybeSingle()
  if (error) throw new Error(error.message || String(error))
  return data?.value || null
}

function gateFor({ row, record, now, manual, mayRun }) {
  const { hour, day } = localClock(now, row.timezone)
  const ranToday = !!row.last_run_at && localClock(new Date(row.last_run_at), row.timezone).day === day
  const midFlight = record?.runBy === 'scheduler' && record?.server?.phase && record.server.phase !== 'done'
  // A digest from today, whoever ran it, is never replaced (see dailyDigest.js).
  const hasPapers = Array.isArray(record?.results) && record.results.length > 0
  const ranAt = record?.ranAt ?? record?.savedAt
  const savedToday = hasPapers && ranAt && localClock(new Date(ranAt), row.timezone).day === day
  return digestGate({ manual, hour, hourLocal: row.hour_local, ranToday, midFlight: !!midFlight, savedToday: !!savedToday, mayRun })
}

const DEFAULT_HOUR_LOCAL = 6
const DEFAULT_TIMEZONE = 'America/New_York'
const SCHEDULE_COLUMNS = 'user_id, enabled, hour_local, timezone, claimed_at, last_run_at, last_attempt_at, attempt_day, attempts_today'

// Finished runs this account has made today, local time. attempt_day is the date the
// database stamped in the row's timezone on the last finish; another day means zero.
export function attemptsToday(row, now) {
  if (!row?.attempt_day) return 0
  const today = localClock(now, row.timezone).day
  return String(row.attempt_day).slice(0, 10) === today ? Number(row.attempts_today) || 0 : 0
}

// Cron's queue: least recently attempted first, never attempted before everyone. Stable, so
// ties keep the database order. Pure; exported for tests.
export function orderByAttempt(rows) {
  const at = (r) => (r.last_attempt_at ? new Date(r.last_attempt_at).getTime() || 0 : 0)
  return [...(rows || [])].map((r, i) => [r, i]).sort((a, b) => at(a[0]) - at(b[0]) || a[1] - b[1]).map(([r]) => r)
}

// A manual "run now" from a sponsored account that has never saved a schedule. Returns
// { created: true } when a row was inserted, { skipped: true } when there is nothing to
// add (not sponsored, or a row already exists — including one that is turned off), or
// { error } when a read or the insert failed.
export async function ensureManualSchedule(admin, userId, now, timezone) {
  const { data: account, error: accountError } = await admin.from('sponsored_accounts').select('user_id, active, ends_at').eq('user_id', userId).maybeSingle()
  if (accountError) return { error: 'accounts unavailable' }
  if (!accountActive(account, now)) return { skipped: true }
  const { data: row, error: rowError } = await admin.from('digest_schedules').select('user_id, enabled').eq('user_id', userId).maybeSingle()
  if (rowError) return { error: 'schedules unavailable' }
  if (row) return { skipped: true }
  const { error: insertError } = await admin.from('digest_schedules').insert({
    user_id: userId,
    enabled: true,
    hour_local: DEFAULT_HOUR_LOCAL,
    timezone: requestedTimezone(timezone) || DEFAULT_TIMEZONE,
  })
  if (insertError) return { error: 'schedule unavailable' }
  return { created: true }
}

// deps: { cronSecret, getUser(authHeader), admin, ledger, dispatch, now(),
//         app: { makeSupabaseStore, schedulerMayRun, runDailyDigest },
//         makeClient(fetch) -> Anthropic client, runInScope(scope, fn),
//         provenance: server-owned cache provenance ({ writer, bundle_source_sha256, ... }) }
export async function handleDigestRun(req, deps) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  const { admin, app } = deps
  const now = deps.now ? deps.now() : new Date()

  let targetUserId = null
  let manual = false
  if (deps.cronSecret && req.headers.get('x-cron-secret') === deps.cronSecret) {
    manual = false
  } else {
    let user = null
    try { user = await deps.getUser(req.headers.get('authorization') || '') } catch { user = null }
    if (!user?.id) return json(401, { error: 'unauthorized' })
    targetUserId = user.id
    manual = true
  }
  let days
  let timezone = null
  if (manual) {
    const body = await req.json().catch(() => ({}))
    const n = Number(body?.days)
    if (Number.isFinite(n) && n > 0 && n <= 30) days = n
    timezone = body?.timezone
  }

  let q = admin.from('digest_schedules').select(SCHEDULE_COLUMNS).eq('enabled', true).order('last_attempt_at', { ascending: true, nullsFirst: true })
  if (targetUserId) q = q.eq('user_id', targetUserId)
  let { data: rows, error: rowsError } = await q
  if (rowsError) return json(503, { ran: false, reason: 'schedules unavailable' })
  if (manual && targetUserId && !(rows || []).length) {
    const ensured = await ensureManualSchedule(admin, targetUserId, now, timezone)
    if (ensured.error) return json(503, { ran: false, reason: ensured.error })
    if (ensured.created) {
      const again = await admin.from('digest_schedules').select(SCHEDULE_COLUMNS).eq('enabled', true).eq('user_id', targetUserId)
      if (again.error) return json(503, { ran: false, reason: 'schedules unavailable' })
      rows = again.data
    }
  }
  rows = manual ? rows || [] : orderByAttempt(rows)
  const ids = rows.map((r) => r.user_id)
  if (!ids.length) return json(200, { ran: false, reason: 'nothing due' })
  const { data: accounts, error: accountsError } = await admin.from('sponsored_accounts').select('user_id, active, ends_at').in('user_id', ids)
  if (accountsError) return json(503, { ran: false, reason: 'accounts unavailable' })
  const accountById = new Map((accounts || []).map((a) => [a.user_id, a]))

  let picked = null
  let reason = 'nothing due'
  for (const row of rows) {
    if (!accountActive(accountById.get(row.user_id), now)) continue
    if (row.claimed_at && now.getTime() - new Date(row.claimed_at).getTime() < CLAIM_STALE_SECONDS * 1000) { reason = 'already running'; continue }
    if (!manual && attemptsToday(row, now) >= ATTEMPTS_PER_DAY) { reason = 'attempt cap reached'; continue }
    let record
    try { record = await readLatest(admin, row.user_id) } catch { reason = 'storage unavailable'; continue }
    const gate = gateFor({ row, record, now, manual, mayRun: app.schedulerMayRun(record) })
    if (!gate.run) { reason = gate.reason; continue }

    // Preflight only (no reservation): skip an account whose spending is stopped.
    const { data: status, error: statusError } = await admin.rpc('spend_status', { p_user_id: row.user_id })
    if (statusError || !status) return json(503, { ran: false, reason: 'accounting unavailable' })
    if (!status.allowed) {
      reason = `spending stopped: ${status.reason}`
      await admin.from('digest_schedules').update({ last_result: `skipped: ${status.reason}`.slice(0, 200), updated_at: now.toISOString() }).eq('user_id', row.user_id).is('claim_token', null).then(() => {}, () => {})
      continue
    }

    const { data: token, error: claimError } = await admin.rpc('digest_claim', { p_user_id: row.user_id, p_stale_seconds: CLAIM_STALE_SECONDS })
    if (claimError) return json(503, { ran: false, reason: 'claim unavailable' })
    if (!token) { reason = 'already running'; continue }

    // Re-check with fresh state now that this run owns the account: another tick may have
    // finished between the first read and the claim.
    let fresh
    try {
      const { data: again, error } = await admin.from('digest_schedules').select('user_id, enabled, hour_local, timezone, last_run_at').eq('user_id', row.user_id).maybeSingle()
      if (error || !again) throw new Error('schedule unavailable')
      fresh = { row: again, record: await readLatest(admin, row.user_id) }
    } catch {
      // Nothing ran: release the claim without stamping an attempt.
      await admin.rpc('digest_claim_release', { p_user_id: row.user_id, p_token: token }).then(() => {}, () => {})
      reason = 'storage unavailable'
      continue
    }
    const regate = gateFor({ row: fresh.row, record: fresh.record, now, manual, mayRun: app.schedulerMayRun(fresh.record) })
    if (!regate.run) {
      await admin.rpc('digest_claim_release', { p_user_id: row.user_id, p_token: token }).then(() => {}, () => {})
      reason = regate.reason
      continue
    }
    picked = { row: fresh.row, token }
    break
  }
  if (!picked) return json(200, { ran: false, reason })

  const userId = picked.row.user_id
  const outcomes = []
  // What the digest runner reads through serverRunUnresolved(): set when a DISPATCHED attempt
  // has no confirmed cost (ambiguous, or settled/marked on the provider side but not recorded).
  const run = { unresolved: null }
  const guarded = makeGuardedFetch({ ledger: deps.ledger, dispatch: deps.dispatch, countTokens: deps.countTokens, userId, claimToken: picked.token, onOutcome: (r) => {
    outcomes.push(r.reason === 'claim_lost' ? 'claim_lost' : r.outcome)
    if (r.dispatched && (r.outcome === 'ambiguous' || r.accountingFailed)) run.unresolved ??= r.outcome
  } })
  const scope = {
    userId,
    run,
    store: fencedStore(app.makeSupabaseStore({ client: admin, userId }), { admin, userId, token: picked.token }),
    client: deps.makeClient(guarded.fetch),
    cache: { client: admin, userId, provenance: deps.provenance || null },
  }

  const log = []
  let result
  try {
    result = await deps.runInScope(scope, () => app.runDailyDigest({ budgetMs: BUDGET_MS, days, log: (line) => log.push(line) }))
  } catch (err) {
    result = { phase: 'error', note: err?.message || String(err) }
  }
  // An unresolved attempt always reports as held unless the digest genuinely finished: a run that
  // threw after it (a failed save, an unexpected error) is still stopped by the database, and
  // "error: it will try again" would be false.
  if (run.unresolved && result.phase !== 'done' && result.phase !== 'empty' && result.phase !== 'held') {
    result = { ...result, phase: 'held', note: `${HELD_NOTE}${result.note ? ` (${result.note})` : ''}` }
  }

  const finished = result.phase === 'done' || result.phase === 'empty'
  const summary = `${result.phase}: ${result.papers ?? 0} papers, read ${result.read ?? 0}${result.note ? `; ${result.note}` : ''}`
  const { data: stillOwner, error: finishError } = await admin.rpc('digest_claim_finish', { p_user_id: userId, p_token: picked.token, p_finished: finished, p_result: summary })
  const claimLost = !!finishError || stillOwner !== true || guarded.state.halted === 'claim_lost'
  const spend = { attempts: guarded.state.attempts, dispatched: guarded.state.dispatched, halted: guarded.state.halted, unresolved: run.unresolved, outcomes }
  await admin.from('events').insert({ user_id: userId, type: 'digest_scheduled_run', payload: { phase: result.phase, papers: result.papers ?? 0, read: result.read ?? 0, manual, claimLost, spend } }).then(() => {}, () => {})

  await observeDigest(admin, { finished, failed: result.phase === 'error' || result.phase === 'held' || claimLost })
  return json(200, { ran: true, user_id: userId, ...result, claimLost, spend, log })
}
