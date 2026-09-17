// supabase/functions/model/logic.js — the pure half of the model proxy.
//
// Everything here is plain ESM with no Deno or network dependency so the app's vitest
// suite covers it (src/lib/sponsorLogic.test.js imports this file). index.ts wires
// these functions to HTTP, Supabase, and Anthropic.

// USD per million tokens. Mirrors modelRates() in src/lib/anthropic.js; keep the two
// in step. Cache reads are billed at a tenth of input. Unknown models take the Sonnet
// rate so a new model id never bills at zero.
export function modelRates(model, now = new Date()) {
  const id = String(model || '')
  if (id.includes('haiku-4-5')) return { input: 1, output: 5 }
  if (id.includes('opus')) return { input: 5, output: 25 }
  if (id.includes('sonnet-5')) {
    return now < new Date('2026-09-01T00:00:00Z') ? { input: 2, output: 10 } : { input: 3, output: 15 }
  }
  return { input: 3, output: 15 }
}

export function costUsd(model, usage, now = new Date()) {
  const input = Number(usage?.input_tokens || 0) + Number(usage?.cache_creation_input_tokens || 0)
  const cached = Number(usage?.cache_read_input_tokens || 0)
  const output = Number(usage?.output_tokens || 0)
  const r = modelRates(model, now)
  return ((input * r.input) + (cached * r.input * 0.1) + (output * r.output)) / 1_000_000
}

// The cap decision. `spent` is what the ledger already holds for this user today and
// this month, plus the global total this month. `caps` merges the account's overrides
// with the config defaults. Returns null when the call may proceed, else which cap.
export function capReached({ spentToday, spentMonth, spentGlobalMonth }, caps) {
  if (caps.globalMonthlyCeilingUsd != null && spentGlobalMonth >= caps.globalMonthlyCeilingUsd) return 'global'
  if (caps.monthlyCapUsd != null && spentMonth >= caps.monthlyCapUsd) return 'month'
  if (caps.dailyCapUsd != null && spentToday >= caps.dailyCapUsd) return 'day'
  return null
}

export function effectiveCaps(account, config) {
  return {
    dailyCapUsd: account?.daily_cap_usd != null ? Number(account.daily_cap_usd) : Number(config?.default_daily_cap_usd),
    monthlyCapUsd: account?.monthly_cap_usd != null ? Number(account.monthly_cap_usd) : Number(config?.default_monthly_cap_usd),
    globalMonthlyCeilingUsd: Number(config?.global_monthly_ceiling_usd),
  }
}

// An account row is usable only while active and not past its end date.
export function accountActive(account, now = new Date()) {
  if (!account || account.active === false) return false
  if (account.ends_at && new Date(account.ends_at) <= now) return false
  return true
}

// UTC day and month windows. Caps reset at 00:00 UTC; the user-facing message says
// "tomorrow morning", which is true everywhere in the Americas.
export function windows(now = new Date()) {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return { dayStart: dayStart.toISOString(), monthStart: monthStart.toISOString() }
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

// The proxy accepts exactly one shape: a non-streaming Messages request. Streaming is
// rejected because usage arrives at the end of the stream and the ledger must be written
// from a complete response. Returns an error string or null.
export function validateRequest(body) {
  if (!body || typeof body !== 'object') return 'Request body must be a JSON object.'
  if (body.stream === true) return 'Streaming is not supported through the sponsored proxy.'
  if (typeof body.model !== 'string' || !body.model.startsWith('claude-')) return 'A Claude model id is required.'
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages is required.'
  const max = Number(body.max_tokens)
  if (!Number.isFinite(max) || max < 1 || max > 32000) return 'max_tokens must be between 1 and 32000.'
  return null
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

// Extract the structured-output JSON from a completed response for the cache write.
// Returns null unless the response finished cleanly and parses.
export function extractionFromResponse(res) {
  if (!res || res.stop_reason !== 'end_turn') return null
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  if (!text.trim()) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export const CAP_MESSAGE = 'You have read a lot today. New papers pick up tomorrow morning. Everything already in your library still works.'
