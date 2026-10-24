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

// `import.meta.env` is Vite's; on a server runtime (the digest edge function imports this
// module too) it is undefined, and the server binds its own client instead (lib/server.js).
const env = import.meta.env || {}
const url = env.VITE_SUPABASE_URL
const anonKey = env.VITE_SUPABASE_ANON_KEY

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

// captchaToken: a Turnstile token (lib/captcha.js). Supabase Auth verifies it when
// CAPTCHA protection is on; it is left out entirely when CAPTCHA is not configured.
export async function sendMagicLink(email, captchaToken) {
  const options = { emailRedirectTo: window.location.origin }
  if (captchaToken) options.captchaToken = captchaToken
  const { error } = await supabase.auth.signInWithOtp({ email, options })
  if (error) throw authError(error)
}

// The same email carries a one-time code alongside the link (template must include
// {{ .Token }}). Typing the code signs in THIS context — the only path that works in
// an installed home-screen app, where the emailed link opens the browser's separate
// storage world instead.
// Keep the status and code supabase-js reports, so callers can tell a rate limit or an
// outage from a wrong code. Pure.
export function authError(error) {
  const err = new Error(error?.message || 'Sign-in failed')
  if (error?.status != null) err.status = error.status
  if (error?.code) err.code = error.code
  return err
}

export async function verifyEmailCode(email, code) {
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: code,
    type: 'email',
  })
  if (error) throw authError(error)
  _user = data?.session?.user || null
  return _user
}

// A canonical Gmail sign-in checks the code on the server, which holds the
// stored address. The session tokens are enough to continue; this does not
// take an address argument.
export async function adoptEmailSession({ access_token, refresh_token }) {
  const { data, error } = await supabase.auth.setSession({ access_token, refresh_token })
  if (error) throw new Error(error.message)
  _user = data?.session?.user || null
  return _user
}

export async function signOut() {
  await supabase.auth.signOut()
  _user = null
}
