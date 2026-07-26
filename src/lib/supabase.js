// lib/supabase.js — the Supabase client + auth state, in one place.
//
// Accounts are OPTIONAL: with no VITE_SUPABASE_* env (e.g. a cloned repo), the app
// runs exactly as before — IndexedDB only, no account UI. The anon key is publishable
// (safe in the bundle); row-level security on the server is the security boundary.
// The backend stores app data only — the Anthropic key NEVER goes near it.
//
// Auth is magic-link email (no passwords). supabase-js persists and refreshes the
// session itself; a magic-link click lands as a fresh page load, so boot-time
// `initAuth()` is the single place auth state enters the app.

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(url && anonKey)
export const supabase = supabaseConfigured ? createClient(url, anonKey) : null

// Cached synchronously-readable auth state, set once by initAuth() at boot.
// Components render from this; a sign-in or sign-out always goes through a
// full reload, so it never goes stale mid-session.
let _user = null

export async function initAuth() {
  if (!supabaseConfigured) return null
  const { data } = await supabase.auth.getSession()
  _user = data?.session?.user || null
  return _user
}

export function currentUser() {
  return _user
}

export function isSignedIn() {
  return _user !== null
}

export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  })
  if (error) throw new Error(error.message)
}

// The same email carries a one-time code alongside the link (template must include
// {{ .Token }}). Typing the code signs in THIS context — the only path that works in
// an installed home-screen app, where the emailed link opens the browser's separate
// storage world instead.
export async function verifyEmailCode(email, code) {
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: code,
    type: 'email',
  })
  if (error) throw new Error(error.message)
  _user = data?.session?.user || null
  return _user
}

export async function signOut() {
  await supabase.auth.signOut()
  _user = null
}
