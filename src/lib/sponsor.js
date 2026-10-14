// lib/sponsor.js — is this account on sponsored access?
//
// Sponsored accounts run their model calls through the `model` edge function on the
// sponsor's key instead of a browser-held key of their own. The client learns exactly one
// thing from the server: whether an active sponsored_accounts row exists for the signed-in
// user (column grants hide caps and notes). Cap enforcement lives entirely server-side; the
// client only has to route calls and render the one message when a cap is hit.
//
// Resolved once at boot after auth (refreshSponsorship) and read synchronously after that,
// mirroring how supabase.js caches the user.

import { supabase, supabaseConfigured, currentUser } from './supabase.js'

let _sponsored = false

export const SPONSOR_RETRY_MS = 400

// One read of the sponsorship row. Resolves { ok, sponsored }; ok:false means the read itself
// failed (a transient error), which says nothing about whether the account is sponsored.
async function readSponsorship(user) {
  try {
    const { data, error } = await supabase
      .from('sponsored_accounts')
      .select('user_id, active, ends_at')
      .eq('user_id', user.id)
      .maybeSingle()
    if (error) return { ok: false, sponsored: false }
    return { ok: true, sponsored: data ? sponsorshipActive(data) : false }
  } catch {
    return { ok: false, sponsored: false }
  }
}

// A transient read error is retried once after a short pause, and never overwrites a flag that
// was already true (a sponsored reader must not lose access to a blip). A signed-out or
// unconfigured client is a definite "no".
export async function refreshSponsorship({ retryMs = SPONSOR_RETRY_MS } = {}) {
  const user = currentUser()
  if (!supabaseConfigured || !user) {
    _sponsored = false
    return false
  }
  let result = await readSponsorship(user)
  if (!result.ok) {
    await new Promise((resolve) => setTimeout(resolve, retryMs))
    result = await readSponsorship(user)
  }
  if (result.ok) _sponsored = result.sponsored
  return _sponsored
}

// Pure: the same rule the edge function applies (accountActive in functions/model/logic.js).
export function sponsorshipActive(row, now = new Date()) {
  if (!row || row.active === false) return false
  if (row.ends_at && new Date(row.ends_at) <= now) return false
  return true
}

export function isSponsored() {
  return _sponsored
}

// The server just confirmed enrollment: flip the flag now, whatever the follow-up read says.
export function markSponsored() {
  _sponsored = true
}

// Test seam only.
export function _setSponsoredForTests(value) {
  _sponsored = Boolean(value)
}

// The one user-facing sentence for a cap. No numbers, no money.
export const CAP_MESSAGE = 'You have read a lot today. New papers pick up tomorrow morning. Everything already in your library still works.'
