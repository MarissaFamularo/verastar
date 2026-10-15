// lib/inviteCode.js — redeem a sponsor invite code for the signed-in account.

import { supabase, supabaseConfigured, isSignedIn } from './supabase.js'
import { refreshSponsorship, isSponsored, markSponsored } from './sponsor.js'

export const INVITE_MESSAGES = {
  email_required: 'Verify your email by signing in again, then retry.',
  npi_required: 'Match your name and NPI to finish joining the beta.',
  enrolled: 'You are in. Verastar now does the reading on this account, no key needed.',
  already: 'This account already has sponsored access.',
  invalid: 'That code is not recognized. Check it and try again.',
  expired: 'That code has expired.',
  exhausted: 'That code has been used up. Ask for a new one.',
  inactive: 'That code is no longer active. Ask for a new one.',
  revoked: 'Sponsored access on this account has ended. A new code cannot restart it; ask the person who invited you.',
  paused: 'New sign-ups are paused right now. Try again later.',
  full: 'The beta is full right now. Try again later.',
  slow_down: 'Too many attempts. Try again in an hour.',
  error: 'Something went wrong. Try again in a moment.',
}

// Codes are issued in capitals (FRIENDS-1) and the server matches them exactly, so a friend
// typing "friends-1" on a laptop was rejected as unrecognized. Normalize what was typed to the
// issued form: trimmed, inner spaces removed, long dashes folded to a hyphen, upper-cased.
// Convention that follows from this: every code in sponsor_invites must be stored upper-case.
export function normalizeInviteCode(code) {
  return String(code ?? '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase()
}

export function canRedeem() {
  return supabaseConfigured && isSignedIn()
}

// Resolves { status, cohort? }. Refreshes the client's sponsorship on success so the
// gates flip without a reload.
export async function redeemInviteCode(code) {
  if (!canRedeem()) throw new Error('Sign in first.')
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new Error('Sign in again to continue.')
  const base = String(import.meta.env.VITE_SUPABASE_URL).replace(/\/$/, '')
  const res = await fetch(`${base}/functions/v1/redeem-invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: normalizeInviteCode(code) }),
  })
  let out = null
  try { out = await res.json() } catch { out = null }
  // Enrollment is only a 2xx whose body says so. The NPI gate used to be HTTP 403 with
  // status npi_required; that is the step before matching, never sponsored access. A 403
  // (or any other error) must not refresh sponsorship or read as "you are in", even if a
  // body claims enrolled.
  const status = res.ok
    ? (out?.status || 'error')
    : (out?.status === 'npi_required' ? 'npi_required' : out?.status === 'paused' ? 'paused' : res.status === 429 || out?.status === 'slow_down' ? 'slow_down' : 'error')
  if (res.ok && (status === 'enrolled' || status === 'already')) {
    // The server just said this account is sponsored. If the follow-up read fails, trust it:
    // the gates must flip now, not after a reload.
    await refreshSponsorship()
    if (!isSponsored()) markSponsored()
  }
  return { status, cohort: res.ok ? (out?.cohort || null) : null }
}
