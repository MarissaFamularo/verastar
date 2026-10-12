// eval/evalModels.js — models and prices for the single-paper evaluation harness ONLY.
//
// The shared price table (supabase/functions/_shared/pricing.js) is the sponsored-spend
// contract: the proxy admits exactly its ids. A model listed here and not there can be
// priced and bounded by the offline harness and nothing else — it is not admitted by the
// proxy, not selectable in the browser, not a scheduler default and never written to the
// production evidence cache. Models the shared table already prices are delegated to it
// unchanged, so the harness and production cannot disagree about them.
//
// Claude Haiku 5.5, source (accessed 2026-10-10):
//   https://platform.claude.com/docs/en/models/haiku-5-5/overview
//   https://platform.claude.com/docs/en/about-claude/pricing  (Model pricing; Long context pricing)
//   https://platform.claude.com/docs/en/build-with-claude/effort
// Fixture: src/eval/evalPricing.fixture.json (the rows as read that day).
//
// Haiku 5.5 is priced by prompt length. "A request's prompt length counts all of its input
// tokens, including cache reads and cache writes", and a request over 100,000 tokens pays
// the higher price in EVERY category — not only on the tokens past the threshold. Standard
// global, non-batch rates only: batch, US-only inference (1.1x) and server tools are
// charges this table does not model, so usage carrying them is unpriceable.
//
// Rates are integer micro-dollars (USD 1e-6) per million tokens, as in the shared table.

import { PRICES, isSupportedModel, maxChargeMicro, priceUsage } from '../../supabase/functions/_shared/pricing.js'

export const EVAL_PRICING_SOURCE = {
  urls: [
    'https://platform.claude.com/docs/en/models/haiku-5-5/overview',
    'https://platform.claude.com/docs/en/about-claude/pricing',
    'https://platform.claude.com/docs/en/build-with-claude/effort',
  ],
  accessed: '2026-10-10',
}

const M = 1_000_000

export const EVAL_ONLY_MODELS = Object.freeze({
  'claude-haiku-5-5': Object.freeze({
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    // Prompts of at most this many input tokens pay `standard`; longer prompts pay `long`.
    promptTierThresholdTokens: 100_000,
    standard: Object.freeze({ input: 100_000, cacheWrite5m: 125_000, cacheWrite1h: 200_000, cacheRead: 10_000, output: 500_000 }),
    long: Object.freeze({ input: 500_000, cacheWrite5m: 625_000, cacheWrite1h: 1_000_000, cacheRead: 50_000, output: 2_500_000 }),
    // Effort page: adaptive thinking is on by default; `thinking: {"type": "disabled"}` is
    // accepted "at `high` effort or below" and returns a 400 at xhigh or max. The default
    // effort is `medium`, so a request that sends no effort may disable thinking.
    defaultEffort: 'medium',
    thinkingDisabledAtEffort: Object.freeze(['low', 'medium', 'high']),
  }),
})

// Default effort of the models the shared table prices, for the receipt only (effort
// page: `high` on every model that supports effort except Opus 5.5 and Haiku 5.5; Haiku
// 4.5 does not support the parameter).
const SHARED_DEFAULT_EFFORT = Object.freeze({ 'claude-sonnet-5-5': 'high', 'claude-haiku-4-5-20251001': null })

const own = (model) => (typeof model === 'string' && Object.prototype.hasOwnProperty.call(EVAL_ONLY_MODELS, model) ? EVAL_ONLY_MODELS[model] : null)

export const isEvalOnlyModel = (model) => own(model) !== null
export const isEvalPricedModel = (model) => isSupportedModel(model) || isEvalOnlyModel(model)

export function evalContextWindowTokens(model) {
  return own(model)?.contextWindowTokens ?? (isSupportedModel(model) ? PRICES[model].contextWindowTokens : null)
}

const ceilDiv = (n, d) => Math.floor((n + d - 1) / d)
const nonNegInt = (v) => Number.isSafeInteger(v) && v >= 0

export const promptTier = (spec, promptTokens) => (promptTokens > spec.promptTierThresholdTokens ? 'long' : 'standard')

// The most a request can be billed, in micro-dollars, given hard token bounds. For a
// tiered model the tier is the one the input BOUND falls in: a request whose input cannot
// exceed the threshold cannot be billed at the long rate, and one whose bound is above it
// is bounded at the long rate for every token. Input is priced at the base input rate;
// the harness sends no cache_control, and cache reads are cheaper.
export function evalMaxChargeMicro(model, { maxInputTokens, maxOutputTokens }) {
  const spec = own(model)
  if (!spec) return maxChargeMicro(model, { maxInputTokens, maxOutputTokens })
  if (!nonNegInt(maxInputTokens) || !nonNegInt(maxOutputTokens)) throw new Error('Token bounds must be non-negative integers.')
  const rates = spec[promptTier(spec, maxInputTokens)]
  return ceilDiv(maxInputTokens * rates.input + maxOutputTokens * rates.output, M)
}

// Describes the bound's price basis for the plan.
export function evalChargeBoundBasis(model, { maxInputTokens, maxOutputTokens }) {
  const spec = own(model)
  const where = spec
    ? `at the ${promptTier(spec, maxInputTokens) === 'long' ? `over-${spec.promptTierThresholdTokens}-token` : `up-to-${spec.promptTierThresholdTokens}-token`} prompt list price (eval-only table)`
    : 'at list price'
  return `context window (${maxInputTokens} input tokens) + max_tokens (${maxOutputTokens}) ${where}`
}

// Price a provider usage object: { ok: true, micro, tokens, promptTier } or
// { ok: false, reason } — never a guessed number and never zero for something unpriced.
// Same refusals as the shared priceUsage (missing or malformed counts, server-tool use, a
// non-standard service tier, non-global inference). Cache writes use the per-TTL breakdown
// only when it accounts for every written token, else the 1-hour (dearest) rate.
export function evalPriceUsage(model, usage) {
  const spec = own(model)
  if (!spec) return priceUsage(model, usage)
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
    if (a + b === write) { write5m = a; write1h = b }
  }

  const tools = usage.server_tool_use
  if (tools && typeof tools === 'object' && Object.values(tools).some((n) => Number(n) > 0)) return { ok: false, reason: 'server_tool_use' }
  if (usage.service_tier != null && usage.service_tier !== 'standard') return { ok: false, reason: 'service_tier' }
  if (usage.inference_geo != null && !['global', 'not_available'].includes(usage.inference_geo)) return { ok: false, reason: 'inference_geo' }

  // Prompt length is every input token: uncached, cache reads and cache writes.
  const promptTokens = input + read + write
  if (!nonNegInt(promptTokens)) return { ok: false, reason: 'malformed_usage' }
  // The API rejects a prompt longer than the context window, so usage reporting one is
  // not something this table can explain.
  if (promptTokens > spec.contextWindowTokens) return { ok: false, reason: 'prompt_exceeds_context_window' }
  const tier = promptTier(spec, promptTokens)
  const r = spec[tier]
  const microTimesM = input * r.input + write5m * r.cacheWrite5m + write1h * r.cacheWrite1h + read * r.cacheRead + output * r.output
  return {
    ok: true,
    micro: ceilDiv(microTimesM, M),
    tokens: { input, output, cacheRead: read, cacheWrite: write },
    promptTier: tier,
    promptTokens,
  }
}

// What the request asks of thinking and effort, and what that means on this model, for the
// evaluation receipt. `thinkingSent` is the value actually placed in the request body.
// The harness never sends output_config.effort, so the effective level is the model's
// documented default — which differs between models and is recorded, not equalized.
export function evalThinkingRecord(model, { thinkingRequested = null, thinkingSent = null, effortSent = null } = {}) {
  const spec = own(model)
  const defaultEffort = spec ? spec.defaultEffort : (SHARED_DEFAULT_EFFORT[model] ?? null)
  const effectiveEffort = effortSent ?? defaultEffort
  const record = {
    thinkingRequested,
    thinkingSent,
    effortSent,
    effectiveEffort,
    effectiveEffortBasis: effortSent != null ? 'sent in the request' : defaultEffort != null ? 'not sent; documented model default' : 'not sent; no documented default recorded for this model',
  }
  if (spec && thinkingSent?.type === 'disabled') {
    record.thinkingDisabledSupported = spec.thinkingDisabledAtEffort.includes(effectiveEffort)
  }
  return record
}
