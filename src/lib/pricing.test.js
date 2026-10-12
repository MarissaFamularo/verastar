// The shared price table (supabase/functions/_shared/pricing.js) against the official rows
// transcribed in pricing.fixture.json, plus the cost arithmetic both the backend settlement
// and the browser display use.
import { describe, it, expect } from 'vitest'
import fixture from './pricing.fixture.json'
import { PRICES, SUPPORTED_MODELS, maxChargeMicro, priceUsage, responseModelMatches, microToUsd } from '../../supabase/functions/_shared/pricing.js'
import { MODELS, displayCostUsd } from './anthropic.js'

const M = 1_000_000

describe('price table', () => {
  it('admits exactly the current default models, nothing by prefix', () => {
    expect([...SUPPORTED_MODELS].sort()).toEqual([...new Set(Object.values(MODELS))].sort())
    for (const id of ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5-20261001', 'claude-']) {
      expect(PRICES[id]).toBeUndefined()
    }
  })
  it('matches the official rows read on the access date', () => {
    for (const [id, row] of Object.entries(fixture.rows)) {
      const p = PRICES[id]
      expect({ input: p.input / M, cacheWrite5m: p.cacheWrite5m / M, cacheWrite1h: p.cacheWrite1h / M, cacheRead: p.cacheRead / M, output: p.output / M, maxOutputTokens: p.maxOutputTokens }).toEqual(row)
    }
  })
  it('cache multipliers: Sonnet 5.5 reads at 0.05x, Haiku 4.5 at 0.1x; writes 1.25x (5m) and 2x (1h)', () => {
    const s = PRICES['claude-sonnet-5-5']
    const h = PRICES['claude-haiku-4-5-20251001']
    expect(s.cacheRead / s.input).toBe(0.05)
    expect(h.cacheRead / h.input).toBe(0.1)
    for (const p of [s, h]) {
      expect(p.cacheWrite5m / p.input).toBe(1.25)
      expect(p.cacheWrite1h / p.input).toBe(2)
    }
  })
})

describe('priceUsage', () => {
  const sonnet = 'claude-sonnet-5-5'
  it('prices a plain response exactly', () => {
    expect(priceUsage(sonnet, { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toMatchObject({ ok: true, micro: 12 * M })
  })
  it('rounds up, never down', () => {
    // One Haiku 4.5 cache-read token costs 0.1 micro-dollar: billed as 1.
    expect(priceUsage('claude-haiku-4-5-20251001', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1 }).micro).toBe(1)
    expect(priceUsage(sonnet, { input_tokens: 0, output_tokens: 0 }).micro).toBe(0)
  })
  it('uses the per-TTL breakdown when it accounts for every written token', () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 } }
    expect(priceUsage(sonnet, usage).micro).toBe(2.5 * M)
  })
  it('prices unexplained cache writes at the dearest (1-hour) rate', () => {
    expect(priceUsage(sonnet, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }).micro).toBe(4 * M)
    const partial = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } }
    expect(priceUsage(sonnet, partial).micro).toBe(4 * M)
  })
  it('cache reads at 0.05x on Sonnet 5.5', () => {
    expect(priceUsage(sonnet, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }).micro).toBe(0.1 * M)
  })
  it('refuses to guess: unknown model, missing or malformed usage, unmodelled charges', () => {
    expect(priceUsage('claude-sonnet-5', { input_tokens: 1, output_tokens: 1 })).toEqual({ ok: false, reason: 'unknown_model' })
    expect(priceUsage(sonnet, undefined)).toEqual({ ok: false, reason: 'missing_usage' })
    expect(priceUsage(sonnet, { output_tokens: 3 })).toEqual({ ok: false, reason: 'malformed_usage' })
    expect(priceUsage(sonnet, { input_tokens: -1, output_tokens: 3 })).toEqual({ ok: false, reason: 'malformed_usage' })
    expect(priceUsage(sonnet, { input_tokens: 1.5, output_tokens: 3 })).toEqual({ ok: false, reason: 'malformed_usage' })
    expect(priceUsage(sonnet, { input_tokens: '10', output_tokens: 3 })).toEqual({ ok: false, reason: 'malformed_usage' })
    expect(priceUsage(sonnet, { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } })).toEqual({ ok: false, reason: 'server_tool_use' })
    expect(priceUsage(sonnet, { input_tokens: 1, output_tokens: 1, service_tier: 'priority' })).toEqual({ ok: false, reason: 'service_tier' })
    expect(priceUsage(sonnet, { input_tokens: 1, output_tokens: 1, inference_geo: 'us' })).toEqual({ ok: false, reason: 'inference_geo' })
    expect(priceUsage(sonnet, { input_tokens: 1, output_tokens: 1, service_tier: 'standard', inference_geo: 'global', server_tool_use: { web_search_requests: 0 } }).ok).toBe(true)
  })
})

describe('reservation bound', () => {
  it('prices every bounded input token at the input rate and every output token at the output rate', () => {
    expect(maxChargeMicro('claude-sonnet-5-5', { maxInputTokens: 100_000, maxOutputTokens: 16_384 })).toBe(200_000 + 163_840)
    expect(maxChargeMicro('claude-haiku-4-5-20251001', { maxInputTokens: 3, maxOutputTokens: 1 })).toBe(8)
  })
  it('rounds up a fractional micro-dollar', () => {
    expect(maxChargeMicro('claude-haiku-4-5-20251001', { maxInputTokens: 1, maxOutputTokens: 0 })).toBe(1)
  })
  it('a settled response within its bounds never exceeds the reservation', () => {
    const bound = { maxInputTokens: 50_000, maxOutputTokens: 8192 }
    const reserved = maxChargeMicro('claude-sonnet-5-5', bound)
    const worst = priceUsage('claude-sonnet-5-5', { input_tokens: 50_000, output_tokens: 8192 }).micro
    expect(worst).toBeLessThanOrEqual(reserved)
  })
  it('refuses unknown models and non-integer bounds', () => {
    expect(() => maxChargeMicro('claude-opus-5-5', { maxInputTokens: 1, maxOutputTokens: 1 })).toThrow()
    expect(() => maxChargeMicro('claude-sonnet-5-5', { maxInputTokens: 1.5, maxOutputTokens: 1 })).toThrow()
  })
})

describe('response model and display parity', () => {
  it('settles only when the response names the requested model', () => {
    expect(responseModelMatches('claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe(true)
    expect(responseModelMatches('claude-sonnet-5-5', 'claude-sonnet-5')).toBe(false)
    expect(responseModelMatches('claude-haiku-4-5-20251001', 'claude-haiku-4-5')).toBe(false)
    expect(responseModelMatches('claude-sonnet-5-5', undefined)).toBe(false)
  })
  it('the browser display equals the backend settlement for supported usage', () => {
    const cases = [
      ['claude-sonnet-5-5', { input_tokens: 12_345, output_tokens: 678, cache_read_input_tokens: 999 }],
      ['claude-sonnet-5-5', { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 77 }],
      ['claude-haiku-4-5-20251001', { input_tokens: 4321, output_tokens: 123, cache_read_input_tokens: 7 }],
    ]
    for (const [model, usage] of cases) {
      expect(displayCostUsd(model, usage)).toBe(microToUsd(priceUsage(model, usage).micro))
    }
  })
})
