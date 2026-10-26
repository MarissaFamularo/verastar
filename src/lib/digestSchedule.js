// lib/digestSchedule.js — a sponsored reader's morning-digest schedule.
//
// One row per account in `digest_schedules`: enabled, local hour, timezone. The server
// (functions/digest-run) reads it; the reader edits it from Settings. Signed out or not
// sponsored there is nothing to schedule and every function here resolves to null.

import { supabase, supabaseConfigured, currentUser, isSignedIn } from './supabase.js'
import { isSponsored, CAP_MESSAGE } from './sponsor.js'
import { denialMessage } from '../../supabase/functions/_shared/spending.js'

export const DEFAULT_HOUR = 6

export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'
  } catch {
    return 'America/New_York'
  }
}

export function canSchedule() {
  return supabaseConfigured && isSignedIn() && isSponsored()
}

export async function getDigestSchedule() {
  if (!canSchedule()) return null
  const { data, error } = await supabase
    .from('digest_schedules')
    .select('enabled, hour_local, timezone, last_run_at, last_result, unopened_streak, paused_at, email_digest')
    .eq('user_id', currentUser().id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

// `emailDigest` is the reader's email switch; the in-app digest is unaffected by it.
export async function setDigestSchedule({ enabled = true, hour = DEFAULT_HOUR, timezone = browserTimezone(), emailDigest = true } = {}) {
  if (!canSchedule()) return null
  const row = { user_id: currentUser().id, enabled: !!enabled, hour_local: Math.max(0, Math.min(23, Math.round(Number(hour)))), timezone, email_digest: !!emailDigest }
  const { error } = await supabase.from('digest_schedules').upsert(row, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)
  return row
}

// What to tell a reader when the server answered but did not start a run. Known reasons
// are plain language; anything else keeps the server's reason so the screen is not a dead end.
export function digestRefusalMessage(reason) {
  if (reason === "today's digest already exists") return 'Today\u2019s digest is already here. The next run is tomorrow morning.'
  if (reason === 'already running') return 'Your digest is already being prepared. It will be on the Digest tab in a few minutes.'
  if (reason === 'nothing due') return 'No digest schedule is turned on for this account, so the server did not start a run.'
  if (reason === 'not yet') return 'It is more than an hour before your digest hour, so the automatic build has not started.'
  if (reason === 'already ran today') return 'A digest already finished for today.'
  if (reason === 'last digest unopened') return 'The last digest is still unopened, so a new automatic run is waiting.'
  if (reason === 'past catch-up window') return 'It is more than twelve hours past your digest hour, so today’s automatic run is skipped. The next one is tomorrow morning; "Run now" starts one today.'
  if (reason === 'paused: digests unopened') return 'Automatic runs are paused because the last seven digests were neither opened here nor clicked in the email. Open the Digest tab, click a link in a digest email, or run now, and they resume.'
  if (reason === 'attempt cap reached') return 'The server has already tried this digest several times today. It will try again tomorrow morning.'
  // The scheduler's preflight names the same denial reasons as the proxy; same sentences.
  if (typeof reason === 'string' && reason.startsWith('spending stopped:')) {
    return denialMessage(reason.slice('spending stopped: '.length).trim())
  }
  if (reason) return `The digest server did not start a run (${reason}). Try again in a minute.`
  return 'The digest server did not start a run. Try again in a minute.'
}

// digest_claim only takes an enabled row, and a new sponsored account has none until
// Settings is saved. Create the table default (on, 6:00, this browser's timezone) so a
// manual run can start. A row the reader already saved — including one turned off — is
// left alone. A write failure is not fatal: the server can create the row itself.
async function ensureDefaultSchedule() {
  try {
    const existing = await getDigestSchedule()
    if (existing) return existing
    return await setDigestSchedule({ enabled: true, hour: DEFAULT_HOUR, timezone: browserTimezone() })
  } catch {
    return null
  }
}

// "Run mine now": the same server path the schedule takes, ignoring the hour. One call is
// one server tick (about a minute of reading); a run that needs more resumes on the next
// call or the next cron tick. `days` widens a fresh run's search window, this run only.
export async function runScheduledDigestNow({ days } = {}) {
  if (!canSchedule()) return null
  await ensureDefaultSchedule()
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new Error('Sign in again to continue.')
  const base = String(import.meta.env.VITE_SUPABASE_URL).replace(/\/$/, '')
  const res = await fetch(`${base}/functions/v1/digest-run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(Number(days) > 0 ? { days } : {}), timezone: browserTimezone() }),
  })
  if (!res.ok) {
    let body = null
    try { body = await res.json() } catch { body = null }
    const err = new Error(`Digest run failed (${res.status}).`)
    err.status = res.status
    if (body && typeof body === 'object') err.reason = body.reason || body.status || null
    throw err
  }
  return res.json()
}

export const PAUSED_RUN_NOTE = 'Digest runs are paused right now. Nothing is wrong with your account; try again later.'

// What to tell a reader when the digest server answered with an HTTP failure. Pure.
export function serverRunFailureNote(err) {
  const status = Number(err?.status)
  const reason = String(err?.reason ?? '')
  if (reason === 'paused' || status === 503) return PAUSED_RUN_NOTE
  if (status === 402 || /cap/.test(reason)) return CAP_MESSAGE
  if (status === 401 || status === 403) return 'Sign in again to start your digest.'
  if (status === 429) return 'Too many digest requests right now. Try again in a few minutes.'
  return `The digest did not start (server error ${status || 'unknown'}). Try again in a minute.`
}

export function hourLabel(h) {
  const n = Number(h)
  const suffix = n < 12 ? 'am' : 'pm'
  const twelve = n % 12 === 0 ? 12 : n % 12
  return `${twelve}:00 ${suffix}`
}
