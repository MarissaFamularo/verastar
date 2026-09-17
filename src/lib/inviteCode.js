// lib/inviteCode.js — redeem a sponsor invite code for the signed-in account.

import { supabase, supabaseConfigured, isSignedIn } from './supabase.js'
import { refreshSponsorship } from './sponsor.js'

export const INVITE_MESSAGES = {
  enrolled: 'You are in. Verastar now does the reading on this account, no key needed.',
  already: 'This account already has sponsored access.',
  invalid: 'That code is not recognized. Check it and try again.',
  expired: 'That code has expired.',
  exhausted: 'That code has been used up. Ask for a new one.',
  slow_down: 'Too many attempts. Try again in an hour.',
  error: 'Something went wrong. Try again in a moment.',
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
    body: JSON.stringify({ code: String(code || '').trim() }),
  })
  let out = null
  try { out = await res.json() } catch { out = null }
  const status = out?.status || (res.ok ? 'error' : res.status === 429 ? 'slow_down' : 'error')
  if (status === 'enrolled' || status === 'already') await refreshSponsorship()
  return { status, cohort: out?.cohort || null }
}
