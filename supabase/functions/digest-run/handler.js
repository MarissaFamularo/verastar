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
// Unopened digests (20261025120000_digest_unopened_pause.sql): a finished digest nobody
// opened used to block every later scheduled run for the account. Now it is replaced each
// morning and counted: digest_schedules.unopened_streak is stamped when a run claims the
// account (0 when the reader engaged with the previous digest or pressed "run now", +1 when
// they did not, unchanged after an empty day or mid-flight). Engaged means opened in the app
// (openedAt) or, since the digest is emailed, any sign of the reader after it was built:
// a click on a link in an email (digest-click), the pause email's resume button
// (digest-resume), or a Settings save; all three stamp digest_schedules.engaged_at
// (20261026150000_digest_engagement.sql). At PAUSE_AFTER_UNOPENED the scheduler stops
// starting runs (paused_at), tells the reader once by email, and resumes on the first tick
// after any of those, because that resets the streak to 0.
//
// Delivery: the reader's hour is when the email lands, not when work starts. A scheduled
// build may start BUILD_LEAD_HOURS before her hour (the gate's leadHours), and every cron
// tick first delivers any digest that finished today for an account whose hour has passed
// and whose day is not yet delivered (digest_schedules.delivered_day, compare-and-set so two
// ticks cannot both send). A build that finishes after the hour is delivered on the tick
// that finishes it. The runtime provides the sender (deps.email; index.ts builds one from
// RESEND_API_KEY); the email carries what the stored digest already holds
// (../_shared/digestEmail.js) and a signed one-click unsubscribe link. An account with
// email_digest off has its day marked delivered and gets nothing. Sending is best effort:
// a failure is an event, never a failed run, and the day is not retried.
//
// Callable two ways: from cron with x-cron-secret, or by a signed-in user ("run mine now"),
// which ignores the hour and the pause but keeps the claim and the spending checks.
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
import { buildDigestEmail, buildPauseEmail, digestLinks, pauseLinks, prepareTracker, untracked, DEFAULT_APP_URL } from '../_shared/digestEmail.js'

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
// Consecutive finished digests with papers that went unopened before the scheduler pauses
// the account. Seven: a reader who has not looked all week is told once and left alone.
export const PAUSE_AFTER_UNOPENED = 7
export const PAUSED_REASON = 'paused: digests unopened'
// A scheduled build may start this many hours before the reader's hour, so the morning
// queue is absorbed before anyone's delivery time. The monitor expects the digest by the
// hour itself (private.beta_expected_digest_due).
export const BUILD_LEAD_HOURS = 1

// Pure: was the reader present for `record`? Opened in the app (openedAt), or engaged
// (a click in an email, the pause email's resume button, a Settings save: engagedAt, from
// digest_schedules.engaged_at) at or after the digest was built. A record with no build
// time counts any engagement: wrongly pausing a reader is the worse mistake.
export function readerEngaged(record, engagedAt) {
  if (record?.openedAt) return true
  const engaged = engagedAt ? new Date(engagedAt).getTime() : NaN
  if (!Number.isFinite(engaged)) return false
  const built = new Date(record?.ranAt ?? record?.savedAt ?? NaN).getTime()
  return !Number.isFinite(built) || engaged >= built
}

// Pure: the account's unopened streak once the scheduler replaces `record` (the stored
// daily digest, or null). A manual run means the reader is present: 0. An unfinished
// scheduler record is a run being resumed, and a record without papers is an empty day:
// both leave the streak alone. A finished digest with papers counts: engaged with
// (readerEngaged) resets to 0, otherwise it adds one.
export function nextUnopenedStreak(record, current, { manual = false, engagedAt = null } = {}) {
  const cur = Math.max(0, Number(current) || 0)
  if (manual) return 0
  if (!record || record.kind !== 'daily') return cur
  if (record.runBy === 'scheduler' && record.server?.phase && record.server.phase !== 'done') return cur
  const hasPapers = Array.isArray(record.results) && record.results.length > 0
  if (!hasPapers) return cur
  return readerEngaged(record, engagedAt) ? 0 : cur + 1
}

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
  return digestGate({ manual, hour, hourLocal: row.hour_local, leadHours: BUILD_LEAD_HOURS, ranToday, midFlight: !!midFlight, savedToday: !!savedToday, mayRun })
}

// Today's finished digest, if the stored record is one: finished, with papers, run today
// in the account's local day.
function finishedToday(record, timezone, day) {
  if (!record || record.kind !== 'daily') return false
  if (!Array.isArray(record.results) || !record.results.length) return false
  if (record.runBy === 'scheduler' && record.server?.phase && record.server.phase !== 'done') return false
  const ranAt = record.ranAt ?? record.savedAt
  return !!ranAt && localClock(new Date(ranAt), timezone).day === day
}

// Email every account in `rows` whose hour has passed, whose last finished run was today,
// and whose day is not yet delivered. The day is claimed first with a compare-and-set on
// delivered_day, so overlapping ticks cannot both send and a failed send is not retried.
// An empty digest, or an account that turned the email off, claims the day and sends nothing.
async function deliverDue(admin, email, rows, now) {
  if (!email?.send) return
  for (const row of rows || []) {
    const { hour, day } = localClock(now, row.timezone)
    if (row.delivered_day === day) continue
    if (hour < Number(row.hour_local)) continue
    if (!row.last_run_at || localClock(new Date(row.last_run_at), row.timezone).day !== day) continue
    let record
    try { record = await readLatest(admin, row.user_id) } catch { continue }
    const ready = finishedToday(record, row.timezone, day)
    let claim = admin.from('digest_schedules').update({ delivered_day: day, updated_at: now.toISOString() }).eq('user_id', row.user_id)
    claim = row.delivered_day == null ? claim.is('delivered_day', null) : claim.eq('delivered_day', row.delivered_day)
    const { data: won, error } = await claim.select('user_id')
    if (error || !won?.length) continue
    row.delivered_day = day
    if (!ready || row.email_digest === false) continue
    await deliver(admin, email, row, {
      build: async ({ unsubscribeUrl }) => buildDigestEmail({
        record, unsubscribeUrl,
        track: await trackerFor(email, row.user_id, digestLinks(record, email.appUrl || DEFAULT_APP_URL)),
        appUrl: email.appUrl || DEFAULT_APP_URL,
        replyTo: email.replyTo || null,
        hourLabel: hourText(row.hour_local),
        timezone: row.timezone || '',
      }),
      sentType: 'digest_emailed',
      failedType: 'digest_email_failed',
      payload: { papers: record.results.length },
    })
  }
}

const DEFAULT_HOUR_LOCAL = 6

// "6:00 am" for the email footer; mirrors hourLabel in src/lib/digestSchedule.js.
function hourText(h) {
  const n = Number(h)
  if (!Number.isInteger(n) || n < 0 || n > 23) return ''
  const twelve = n % 12 === 0 ? 12 : n % 12
  return `${twelve}:00 ${n < 12 ? 'am' : 'pm'}`
}
const DEFAULT_TIMEZONE = 'America/New_York'
const SCHEDULE_COLUMNS = 'user_id, enabled, hour_local, timezone, claimed_at, last_run_at, last_attempt_at, attempt_day, attempts_today, unopened_streak, paused_at, email_digest, delivered_day, engaged_at'

async function recordEvent(admin, userId, type, payload) {
  await admin.from('events').insert({ user_id: userId, type, payload }).then(() => {}, () => {})
}

// Deliver one email through deps.email and record the outcome as an event. Never throws.
// An account that turned the email off (Settings, or the unsubscribe link) gets nothing,
// silently: that is its choice, not a failure.
async function deliver(admin, email, row, { build, sentType, failedType, payload = {} }) {
  if (!email?.send) return
  if (row.email_digest === false) return
  const userId = row.user_id
  try {
    const to = await email.getAddress(userId)
    if (!to) {
      await recordEvent(admin, userId, failedType, { ...payload, error: 'no address' })
      return
    }
    const unsubscribeUrl = email.unsubscribeUrl ? await email.unsubscribeUrl(userId) : null
    const message = await build({ to, unsubscribeUrl })
    if (!message) return
    const out = await email.send({ to, subject: message.subject, text: message.text, html: message.html, headers: message.headers || null })
    await recordEvent(admin, userId, sentType, { ...payload, provider_id: out?.id ?? null })
  } catch (err) {
    await recordEvent(admin, userId, failedType, { ...payload, error: String(err?.message || err).slice(0, 200) })
  }
}

// The href lookup for one email's links: each signed through digest-click when the runtime
// can (email.clickUrl), printed as-is otherwise.
async function trackerFor(email, userId, links) {
  if (!email?.clickUrl) return untracked
  return prepareTracker(links, (link) => email.clickUrl(userId, link))
}

// The account reached the pause threshold: stamp paused_at once (the row is idle, so the
// write is fenced on "no claim"), record it, and tell the reader once.
async function pauseAccount(admin, email, row, streak, now) {
  if (row.paused_at) return
  await admin.from('digest_schedules').update({ paused_at: now.toISOString(), updated_at: now.toISOString() }).eq('user_id', row.user_id).is('claim_token', null).is('paused_at', null).then(() => {}, () => {})
  await recordEvent(admin, row.user_id, 'digest_paused', { streak })
  await deliver(admin, email, row, {
    build: async ({ unsubscribeUrl }) => {
      const appUrl = email.appUrl || DEFAULT_APP_URL
      let resumeUrl = null
      try { resumeUrl = email.resumeUrl ? await email.resumeUrl(row.user_id) : null } catch { resumeUrl = null }
      const track = await trackerFor(email, row.user_id, pauseLinks(appUrl))
      return buildPauseEmail({ appUrl, streak, replyTo: email.replyTo || null, unsubscribeUrl, resumeUrl, track })
    },
    sentType: 'digest_pause_emailed',
    failedType: 'digest_pause_email_failed',
    payload: { streak },
  })
}

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
  // Deliveries first: they are cheap, and a digest built early must not wait behind a build.
  if (!manual) await deliverDue(admin, deps.email, rows, now)
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
    // An unopened digest no longer blocks the next one; it is counted, and the count pauses
    // the account at the threshold. Opening the digest resets the count, so the next tick
    // after that resumes without any other action.
    const streak = nextUnopenedStreak(record, row.unopened_streak, { manual, engagedAt: row.engaged_at })
    if (!manual && streak >= PAUSE_AFTER_UNOPENED) {
      reason = PAUSED_REASON
      await pauseAccount(admin, deps.email, row, streak, now)
      continue
    }
    const gate = gateFor({ row, record, now, manual, mayRun: true })
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
      const { data: again, error } = await admin.from('digest_schedules').select('user_id, enabled, hour_local, timezone, last_run_at, unopened_streak, paused_at, email_digest, delivered_day, engaged_at').eq('user_id', row.user_id).maybeSingle()
      if (error || !again) throw new Error('schedule unavailable')
      fresh = { row: again, record: await readLatest(admin, row.user_id) }
    } catch {
      // Nothing ran: release the claim without stamping an attempt.
      await admin.rpc('digest_claim_release', { p_user_id: row.user_id, p_token: token }).then(() => {}, () => {})
      reason = 'storage unavailable'
      continue
    }
    const regate = gateFor({ row: fresh.row, record: fresh.record, now, manual, mayRun: true })
    if (!regate.run) {
      await admin.rpc('digest_claim_release', { p_user_id: row.user_id, p_token: token }).then(() => {}, () => {})
      reason = regate.reason
      continue
    }
    // This run replaces fresh.record: stamp what the streak becomes, fenced on the claim.
    // A paused account only gets here after the reader opened the digest or pressed "run
    // now", so the stamp also clears the pause.
    const stamped = nextUnopenedStreak(fresh.record, fresh.row.unopened_streak, { manual, engagedAt: fresh.row.engaged_at })
    if (stamped !== (Number(fresh.row.unopened_streak) || 0) || fresh.row.paused_at) {
      await admin.from('digest_schedules').update({ unopened_streak: stamped, paused_at: null, updated_at: now.toISOString() }).eq('user_id', row.user_id).eq('claim_token', token).then(() => {}, () => {})
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

  // A build that finished at or after the reader's hour is delivered now rather than on the
  // next tick. One that finished early waits for the hour. A run that lost its claim may
  // not own what is stored, so it delivers nothing.
  if (finished && !claimLost) await deliverDue(admin, deps.email, [{ ...picked.row, last_run_at: now.toISOString() }], now)
  return json(200, { ran: true, user_id: userId, ...result, claimLost, spend, log })
}
