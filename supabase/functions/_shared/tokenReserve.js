// supabase/functions/_shared/tokenReserve.js — how much one paid attempt reserves.
//
// The daily cap is unchanged. What changed is the hold: it is this request's input, not
// the model's whole context window. Input comes from Anthropic's token-counting API
// (https://docs.anthropic.com/en/docs/build-with-claude/token-counting). That page says
// the count is an estimate and can differ by a small amount from the tokens billed, so
// the hold is the count plus a safety margin, plus every output token max_tokens allows.
//
// A count that fails, times out, or comes back unusable falls back to a local estimate.
// That estimate is conservative and is never zero, and it then takes the same margin.
// The hold is also clamped to the context-window ceiling: the API rejects a larger input,
// so a reservation above that ceiling only blocks the cap.

import { PRICES, maxChargeMicro } from './pricing.js'
import { COUNT_TIMEOUT_MS } from './timeouts.js'

// +25%, then a fixed pad. The pad covers the "small amount" the count can miss on a
// short prompt, where a percentage alone is a handful of tokens.
export const COUNT_SAFETY_NUMERATOR = 5
export const COUNT_SAFETY_DENOMINATOR = 4
export const COUNT_SAFETY_PAD_TOKENS = 1_024

// One token per two UTF-8 bytes. English is closer to four characters per token, so this
// over-counts ordinary prose; dense markup still fits under it. At least one token.
export function localInputTokenEstimate(text) {
  const bytes = new TextEncoder().encode(String(text ?? '')).length
  return Math.max(1, Math.ceil(bytes / 2))
}

// Margin on top of a positive raw count, clamped to the model's context window.
export function reservedInputTokens(rawInputTokens, contextWindowTokens) {
  const raw = Number.isSafeInteger(rawInputTokens) && rawInputTokens > 0 ? rawInputTokens : 1
  const padded = Math.ceil((raw * COUNT_SAFETY_NUMERATOR) / COUNT_SAFETY_DENOMINATOR) + COUNT_SAFETY_PAD_TOKENS
  const window = Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0 ? contextWindowTokens : padded
  return Math.max(1, Math.min(window, padded))
}

// micro is what spend_reserve holds. It is at least 1 and never above the context-window
// ceiling for the same max_tokens.
export function reservationCharge(model, { rawInputTokens, maxOutputTokens }) {
  const price = PRICES[model]
  if (!price) throw new Error(`No price for model ${model}`)
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('maxOutputTokens must be a positive integer.')
  const maxInputTokens = reservedInputTokens(rawInputTokens, price.contextWindowTokens)
  const micro = maxChargeMicro(model, { maxInputTokens, maxOutputTokens })
  const ceiling = maxChargeMicro(model, { maxInputTokens: price.contextWindowTokens, maxOutputTokens })
  return { maxInputTokens, maxOutputTokens, micro: Math.min(ceiling, Math.max(1, micro)) }
}

// Count the forwarded request. Any failure, including a timeout and a zero count, returns
// the local estimate. Never returns zero.
export async function resolveInputTokens(forward, forwardText, countTokens, { timeoutMs = COUNT_TIMEOUT_MS } = {}) {
  if (typeof countTokens === 'function') {
    const controller = new AbortController()
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('count_timeout'))
      }, timeoutMs)
    })
    try {
      const n = await Promise.race([
        Promise.resolve().then(() => countTokens(forward, { signal: controller.signal })),
        timeout,
      ])
      if (Number.isSafeInteger(n) && n > 0) return { source: 'counted', tokens: n }
    } catch {
      // The count is an estimate we could not get. Fall through to the local bound.
    } finally {
      clearTimeout(timer)
    }
  }
  return { source: 'estimate', tokens: localInputTokenEstimate(forwardText) }
}
