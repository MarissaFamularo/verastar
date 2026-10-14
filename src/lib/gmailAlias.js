// Gmail treats dots and +tags as the same inbox, and googlemail.com as gmail.com.
// Signing in with a different spelling must open the account already on that inbox.
// The server reports a one-character hint and an opaque ticket. It does not report
// the stored address. Typing that stored address, or the canonical spelling, gets
// the same "no match" as an inbox with no account.

import { awaitWithin } from './deadline.js'
import { isUuid } from './gmailCanonical.js'
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

export function gmailCanonicalNote(hint) {
  return `Signing you in as ${hint} (the account already on this inbox)`
}

// force: the person chose a separate account at the spelling they typed.
// A match with no ticket cannot be delivered without the stored address, so
// sign-in stops instead of opening a second account. Anything else sends to
// the typed address, including an exact account address and a failed lookup.
export function gmailAliasDecision(prepared, { force = false } = {}) {
  if (force) return { send: 'typed', note: '' }
  if (prepared?.match === true && isMaskedGmailHint(prepared.hint)) {
    if (prepared.ticket) {
      return { send: 'canonical', note: gmailCanonicalNote(prepared.hint), ticket: prepared.ticket }
    }
    return { send: 'blocked', note: '' }
  }
  return { send: 'typed', note: '' }
}

function noMatch() {
  return { match: false }
}

// Missing function, rate limit, timeout, and network errors all return no match
// so a code can still be sent to the typed address. A match never includes an
// address, even if a response carries one.
export async function prepareGmailAlias(email, { timeoutMs = GMAIL_ALIAS_LOOKUP_MS } = {}) {
  const typed = String(email || '').trim()
  if (!isGmailFamily(typed) || typeof supabase?.rpc !== 'function') return noMatch()
  try {
    const raced = await awaitWithin(supabase.rpc('gmail_alias_prepare', { p_email: typed }), timeoutMs)
    if (raced.timeout) return noMatch()
    const { data, error } = raced.value || {}
    if (error || !data || data.match !== true || !isMaskedGmailHint(data.hint)) return noMatch()
    return { match: true, hint: data.hint, ticket: isUuid(data.ticket) ? data.ticket : '' }
  } catch {
    return noMatch()
  }
}

// The hint RPC, kept for the audit client. Sign-in uses prepareGmailAlias so a
// different spelling can be delivered without a second rate-limit hit.
export async function lookupGmailAlias(email, { timeoutMs = GMAIL_ALIAS_LOOKUP_MS } = {}) {
  const typed = String(email || '').trim()
  if (!isGmailFamily(typed) || typeof supabase?.rpc !== 'function') return noMatch()
  try {
    const raced = await awaitWithin(supabase.rpc('gmail_alias_hint', { p_email: typed }), timeoutMs)
    if (raced.timeout) return noMatch()
    const { data, error } = raced.value || {}
    if (error || !data || data.match !== true || !isMaskedGmailHint(data.hint)) return noMatch()
    return { match: true, hint: data.hint }
  } catch {
    return noMatch()
  }
}
