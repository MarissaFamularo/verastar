// supabase/functions/_shared/pricing.js — the one price table for sponsored spend.
//
// Plain ESM with no Deno or network dependency: the model proxy, the scheduled digest, the
// browser's BYOK display ledger (src/lib/anthropic.js), and the vitest suite all import
// this file, so the backend's authoritative charge and the browser's displayed estimate
// come from the same numbers.
//
// Only EXACT model ids are priced. An id that is not in the table has no price: the proxy
// refuses it before dispatch, and a response that names an unknown model, or carries
// usage this table cannot price, is never settled at zero or at a fallback rate (see
// spending.js: it keeps the full reservation as an ambiguous liability).
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing and
// https://platform.claude.com/docs/en/about-claude/models/overview, accessed 2026-10-09.
// Fixture: src/lib/pricing.fixture.json (the rows as read that day). Neither model has a
// prompt-length tier (Sonnet 5.5 has the full 1M context at standard rates; Haiku 4.5 is a
// 200k-context model with no long-context row). Sonnet 5.5 cache reads are 0.05x input;
// Haiku 4.5 uses the standard 0.1x.
//
// Rates are integer micro-dollars (USD 1e-6) per million tokens, so every cost below is
// integer arithmetic with one ceiling at the end: money never rounds down.

export const PRICING_SOURCE = {
  urls: [
    'https://platform.claude.com/docs/en/about-claude/pricing',
    'https://platform.claude.com/docs/en/about-claude/models/overview',
    'https://platform.claude.com/docs/en/build-with-claude/context-windows',
  ],
  accessed: '2026-10-09',
}

const M = 1_000_000 // micro-dollars per dollar

export const PRICES = Object.freeze({
  'claude-sonnet-5-5': Object.freeze({
    input: 2 * M,
    cacheWrite5m: 2.5 * M,
    cacheWrite1h: 4 * M,
    cacheRead: 0.1 * M,
    output: 10 * M,
    maxOutputTokens: 128_000,
    // Context windows page: 1M tokens, the default, no beta header.
    contextWindowTokens: 1_000_000,
    // thinking values this proxy admits for the model ({ type } objects, nothing else).
    thinking: ['between_tools'],
  }),
  'claude-haiku-4-5-20251001': Object.freeze({
    input: 1 * M,
    cacheWrite5m: 1.25 * M,
    cacheWrite1h: 2 * M,
    cacheRead: 0.1 * M,
    output: 5 * M,
    maxOutputTokens: 64_000,
    // Context windows page: models not listed with 1M "have a 200k-token context window".
    contextWindowTokens: 200_000,
    thinking: ['disabled'],
  }),
})

export const SUPPORTED_MODELS = Object.freeze(Object.keys(PRICES))

export function isSupportedModel(model) {
  return typeof model === 'string' && Object.prototype.hasOwnProperty.call(PRICES, model)
}

// ceil(n / d) for non-negative integers, exact.
const ceilDiv = (n, d) => Math.floor((n + d - 1) / d)

const nonNegInt = (v) => Number.isSafeInteger(v) && v >= 0

// The most a request can be billed, in micro-dollars, given hard token bounds.
// requestPolicy.js passes the model's whole context window as `maxInputTokens`: the API
// rejects ("prompt is too long") any request whose input alone exceeds it, and input
// counts every input token (input_tokens + cache reads + cache writes). Input is priced
// at the base input rate, the highest input rate a request can incur here: caching is
// enabled only by cache_control, which the policy refuses, and cache reads are cheaper.
// System tokens Anthropic adds are not billed (token-counting page).
export function maxChargeMicro(model, { maxInputTokens, maxOutputTokens }) {
  const p = PRICES[model]
  if (!p) throw new Error(`No price for model ${model}`)
  if (!nonNegInt(maxInputTokens) || !nonNegInt(maxOutputTokens)) throw new Error('Token bounds must be non-negative integers.')
  return ceilDiv(maxInputTokens * p.input + maxOutputTokens * p.output, M)
}

// Price a provider usage object. Returns { ok: true, micro, tokens } or
// { ok: false, reason } — never a guessed number.
//   - input/output tokens must be present non-negative integers;
//   - cache writes use the per-TTL breakdown when present, else the 1-hour (dearest) rate;
//   - any server-tool use, non-standard service tier, or non-global inference geography is
//     a charge this table does not model, so the usage is unpriceable.
export function priceUsage(model, usage) {
  const p = PRICES[model]
  if (!p) return { ok: false, reason: 'unknown_model' }
  if (!usage || typeof usage !== 'object') return { ok: false, reason: 'missing_usage' }
  const input = usage.input_tokens
  const output = usage.output_tokens
  if (!nonNegInt(input) || !nonNegInt(output)) return { ok: false, reason: 'malformed_usage' }
  const read = usage.cache_read_input_tokens ?? 0
  const write = usage.cache_creation_input_tokens ?? 0
  if (!nonNegInt(read) || !nonNegInt(write)) return { ok: false, reason: 'malformed_usage' }

  let write5m = 0
  let write1h = write
  const breakdown = usage.cache_creation
  if (breakdown && typeof breakdown === 'object') {
    const a = breakdown.ephemeral_5m_input_tokens ?? 0
    const b = breakdown.ephemeral_1h_input_tokens ?? 0
    if (!nonNegInt(a) || !nonNegInt(b)) return { ok: false, reason: 'malformed_usage' }
    // A breakdown that does not account for every written token cannot narrow the price.
    if (a + b === write) { write5m = a; write1h = b }
  }

  const tools = usage.server_tool_use
  if (tools && typeof tools === 'object' && Object.values(tools).some((n) => Number(n) > 0)) {
    return { ok: false, reason: 'server_tool_use' }
  }
  if (usage.service_tier != null && usage.service_tier !== 'standard') return { ok: false, reason: 'service_tier' }
  if (usage.inference_geo != null && !['global', 'not_available'].includes(usage.inference_geo)) {
    return { ok: false, reason: 'inference_geo' }
  }

  const microTimesM =
    input * p.input + write5m * p.cacheWrite5m + write1h * p.cacheWrite1h + read * p.cacheRead + output * p.output
  return {
    ok: true,
    micro: ceilDiv(microTimesM, M),
    tokens: { input, output, cacheRead: read, cacheWrite: write },
  }
}

// The response must name the model that was requested. The admitted ids are pinned
// snapshots (dated, or dateless from the 4.6 generation on), so the API echoes them.
export function responseModelMatches(requested, returned) {
  return isSupportedModel(requested) && returned === requested
}

export function microToUsd(micro) {
  return micro / M
}
