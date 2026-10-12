// Gmail treats dots and +tags as the same inbox, and googlemail.com as gmail.com.
// Signing in with a different spelling must not silently open a second account.
// The server reports only whether a different account already normalizes to this
// inbox, plus a one-character hint. This module never receives the other address.

import { awaitWithin } from './deadline.js'
import { supabase } from './supabase.js'

const MASKED_HINT = /^[^\s@]…@(gmail|googlemail)\.com$/u

// Short on purpose. The sign-in screen is already in "Sending…" during this
// check, and the code-send timeout (8s) does not start until the check returns.
// 2.5s sits inside that budget: a stall becomes "no match" and the code still sends.
export const GMAIL_ALIAS_LOOKUP_MS = 2500

export function isGmailFamily(email) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1] || ''
  return domain === 'gmail.com' || domain === 'googlemail.com'
}

// One visible character, an ellipsis, and a gmail domain. Anything fuller is rejected
// so a bad response cannot paint another person's address on the sign-in screen.
export function isMaskedGmailHint(hint) {
  return typeof hint === 'string' && MASKED_HINT.test(hint)
}

export function gmailAliasWarning(hint) {
  return `You already have an account as ${hint}; sign in with that address?`
}

// force: the person chose to send a code to the address they typed anyway.
// A hint that is not a mask is ignored and sign-in continues.
export function gmailAliasDecision(lookup, { force = false } = {}) {
  if (force) return { send: true, warning: '' }
  if (lookup?.match === true && isMaskedGmailHint(lookup.hint)) {
    return { send: false, warning: gmailAliasWarning(lookup.hint) }
  }
  return { send: true, warning: '' }
}

// Missing function, rate limit, timeout, and network errors all return no match
// so a code can still be sent. The check is a warning, not a lock on the door.
export async function lookupGmailAlias(email, { timeoutMs = GMAIL_ALIAS_LOOKUP_MS } = {}) {
  const typed = String(email || '').trim()
  if (!isGmailFamily(typed) || typeof supabase?.rpc !== 'function') return { match: false }
  try {
    const raced = await awaitWithin(supabase.rpc('gmail_alias_hint', { p_email: typed }), timeoutMs)
    if (raced.timeout) return { match: false }
    const { data, error } = raced.value || {}
    if (error || !data || data.match !== true || !isMaskedGmailHint(data.hint)) return { match: false }
    return { match: true, hint: data.hint }
  } catch {
    return { match: false }
  }
}
