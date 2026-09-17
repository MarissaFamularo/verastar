// lib/digestSchedule.js — a sponsored reader's morning-digest schedule.
//
// One row per account in `digest_schedules`: enabled, local hour, timezone. The server
// (functions/digest-run) reads it; the reader edits it from Settings. Signed out or not
// sponsored there is nothing to schedule and every function here resolves to null.

import { supabase, supabaseConfigured, currentUser, isSignedIn } from './supabase.js'
import { isSponsored } from './sponsor.js'

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
    .select('enabled, hour_local, timezone, last_run_at, last_result')
    .eq('user_id', currentUser().id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

export async function setDigestSchedule({ enabled = true, hour = DEFAULT_HOUR, timezone = browserTimezone() } = {}) {
  if (!canSchedule()) return null
  const row = { user_id: currentUser().id, enabled: !!enabled, hour_local: Math.max(0, Math.min(23, Math.round(Number(hour)))), timezone }
  const { error } = await supabase.from('digest_schedules').upsert(row, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)
  return row
}

// "Run mine now": the same server path the schedule takes, ignoring the hour.
export async function runScheduledDigestNow() {
  if (!canSchedule()) return null
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new Error('Sign in again to continue.')
  const base = String(import.meta.env.VITE_SUPABASE_URL).replace(/\/$/, '')
  const res = await fetch(`${base}/functions/v1/digest-run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`Digest run failed (${res.status}).`)
  return res.json()
}

export function hourLabel(h) {
  const n = Number(h)
  const suffix = n < 12 ? 'am' : 'pm'
  const twelve = n % 12 === 0 ? 12 : n % 12
  return `${twelve}:00 ${suffix}`
}
