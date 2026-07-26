// lib/events.js — the telemetry drop-box (the adoption-study instrument the accounts
// build promised). One append-only row per event: {type, payload}, stamped server-side.
//
// Rules that keep this safe to call from anywhere: signed-out or unconfigured is a
// silent no-op (nothing leaves the browser without an account); failures never throw
// (telemetry must never break the feature it observes); nothing here ever reads back.

import { supabase, supabaseConfigured, currentUser, isSignedIn } from './supabase.js'

export function logEvent(type, payload = {}) {
  if (!supabaseConfigured || !isSignedIn()) return Promise.resolve()
  return supabase
    .from('events')
    .insert({ user_id: currentUser().id, type, payload })
    .then(({ error }) => {
      if (error) console.warn('Event dropped:', error.message)
    })
    .catch(() => {})
}
