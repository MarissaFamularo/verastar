// supabase/functions/model/logic.js — the pure half of the model proxy.
//
// Everything here is plain ESM with no Deno or network dependency so the app's vitest
// suite covers it (src/lib/sponsorLogic.test.js imports this file). Money decisions are
// not here: request bounds, prices and the reserve/settle boundary live in ../_shared/
// (requestPolicy.js, pricing.js, spending.js) and in the spend_* database functions.

// An account row is usable only while active and not past its end date.
export function accountActive(account, now = new Date()) {
  if (!account || account.active === false) return false
  if (account.ends_at && new Date(account.ends_at) <= now) return false
  return true
}

// Local wall-clock hour and calendar day for a timezone (the digest scheduler's clock).
export function localClock(now, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
    const get = (t) => parts.find((p) => p.type === t)?.value || ''
    const hour = Number(get('hour')) % 24
    return { hour, day: `${get('year')}-${get('month')}-${get('day')}` }
  } catch {
    return { hour: now.getUTCHours(), day: now.toISOString().slice(0, 10) }
  }
}

// Should this tick of the digest scheduler run (or continue) one account's digest? The
// edge function gathers the facts; this decides. Returns { run: true } or { run: false, reason }.
//   manual       the reader pressed run (ignores the hour and the opened gate)
//   hour         the account's local hour now; hourLocal is the hour she chose
//   ranToday     a scheduled run already finished today, local time
//   claimedFresh another tick is working on this account right now
//   midFlight    a scheduler run is partway through and should be continued
//   savedToday   a digest with papers already exists from today
//   mayRun       schedulerMayRun(record): the last digest was opened, or there is none
export function digestGate({ manual = false, hour, hourLocal, ranToday = false, claimedFresh = false, midFlight = false, savedToday = false, mayRun = true } = {}) {
  // A manual press respects the claim too: two runners on one record would each persist
  // over the other.
  if (claimedFresh) return { run: false, reason: 'already running' }
  if (savedToday && !midFlight) return { run: false, reason: "today's digest already exists" }
  if (manual) return { run: true }
  if (midFlight) return { run: true }
  if (ranToday) return { run: false, reason: 'already ran today' }
  // At or after her hour, not only during it: a morning skipped because the last digest
  // sat unopened catches up on the first tick after she opens it (2026-09-28).
  if (hour < Number(hourLocal)) return { run: false, reason: 'not yet' }
  if (!mayRun) return { run: false, reason: 'last digest unopened' }
  return { run: true }
}

// The cache header the client sends on an extraction call:
//   x-verastar-cache: <pmid>|<extraction_version>|<sha256 hex>|<source_tier>
// Anything malformed means "no cache", never an error — caching is an optimization.
export function parseCacheHeader(value) {
  if (!value) return null
  const parts = String(value).split('|')
  if (parts.length !== 4) return null
  const [pmid, version, hash, tier] = parts.map((p) => p.trim())
  if (!pmid || !version || !/^[0-9a-f]{64}$/i.test(hash)) return null
  if (!['full_text', 'abstract_only', 'user_text'].includes(tier)) return null
  return { pmid, extraction_version: version, source_hash: hash.toLowerCase(), source_tier: tier }
}

// Build a synthetic Messages response from a cached extraction so the client's existing
// parseStructuredResponse() works unchanged. Usage is zero: nothing was billed.
export function cachedResponse(row, model) {
  return {
    id: `msg_cache_${row.source_hash.slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model: row.model || model,
    content: [{ type: 'text', text: JSON.stringify(row.extraction) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    verastar_cache: true,
  }
}
