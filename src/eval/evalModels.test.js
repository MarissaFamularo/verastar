// evalModels.test.js — the evaluation harness's own price table. Haiku 5.5 is priced here
// and nowhere else: the shared sponsored table, the proxy, the app's model defaults and the
// production cache must not learn about it from this package.

import { describe, it, expect } from 'vitest'
import fixture from './evalPricing.fixture.json'
import {
  EVAL_ONLY_MODELS, EVAL_PRICING_SOURCE, isEvalOnlyModel, isEvalPricedModel, evalContextWindowTokens,
  evalMaxChargeMicro, evalChargeBoundBasis, evalPriceUsage, evalThinkingRecord, promptTier,
} from './evalModels.js'
import { PRICES, SUPPORTED_MODELS, isSupportedModel, maxChargeMicro, priceUsage, responseModelMatches } from '../../supabase/functions/_shared/pricing.js'
import { checkPaidRequest } from '../../supabase/functions/_shared/requestPolicy.js'
import { MODELS, thinkingParam } from '../lib/anthropic.js'
import { CURRENT_EXTRACTION_VERSION } from '../lib/evidenceVersion.js'

const HAIKU = 'claude-haiku-5-5'
const SPEC = EVAL_ONLY_MODELS[HAIKU]
const M = 1_000_000

describe('the eval-only table matches the official rows read on the access date', () => {
  it('prices both prompt tiers exactly as transcribed', () => {
    const row = fixture.rows[HAIKU]
    expect(EVAL_PRICING_SOURCE.accessed).toBe(fixture.accessed)
    for (const tier of ['standard', 'long']) {
      for (const [key, usd] of Object.entries(row[tier])) expect(SPEC[tier][key]).toBe(Math.round(usd * M))
    }
    for (const key of ['contextWindowTokens', 'maxOutputTokens', 'promptTierThresholdTokens', 'defaultEffort']) expect(SPEC[key]).toBe(row[key])
    expect([...SPEC.thinkingDisabledAtEffort]).toEqual(row.thinkingDisabledAtEffort)
  })
  it('every rate is an integer number of micro-dollars, and the long tier is 5x the standard tier', () => {
    for (const key of Object.keys(SPEC.standard)) {
      expect(Number.isSafeInteger(SPEC.standard[key])).toBe(true)
      expect(SPEC.long[key]).toBe(SPEC.standard[key] * 5)
    }
  })
  it('lists only the exact id', () => {
    expect(Object.keys(EVAL_ONLY_MODELS)).toEqual([HAIKU])
    for (const id of ['claude-haiku-5-5-20261007', 'claude-haiku-5', 'haiku-5-5', 'claude-haiku-5-5 ', 'toString', '__proto__', null, undefined, 5]) {
      expect(isEvalOnlyModel(id)).toBe(false)
      expect(isEvalPricedModel(id)).toBe(false)
    }
  })
})

describe('Haiku 5.5 stays out of production', () => {
  it('the shared sponsored table and its helpers do not know the model', () => {
    expect([...SUPPORTED_MODELS]).toEqual(['claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])
    expect(isSupportedModel(HAIKU)).toBe(false)
    expect(PRICES[HAIKU]).toBeUndefined()
    expect(() => maxChargeMicro(HAIKU, { maxInputTokens: 1, maxOutputTokens: 1 })).toThrow(/No price/)
    expect(priceUsage(HAIKU, { input_tokens: 1, output_tokens: 1 })).toEqual({ ok: false, reason: 'unknown_model' })
    expect(responseModelMatches(HAIKU, HAIKU)).toBe(false)
  })
  it('the proxy admission policy refuses it, with or without a thinking mode', () => {
    const body = { model: HAIKU, max_tokens: 8192, messages: [{ role: 'user', content: 'x' }] }
    for (const extra of [{}, { thinking: { type: 'disabled' } }, { thinking: { type: 'adaptive' } }]) {
      expect(checkPaidRequest({ ...body, ...extra })).toEqual({ ok: false, error: 'That model is not available through the sponsored proxy.' })
    }
    // The same body is admitted for a supported model, so the refusal is about the model.
    expect(checkPaidRequest({ ...body, model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' } }).ok).toBe(true)
  })
  it('app model defaults, the shared thinking mapping and the extraction version are unchanged', () => {
    expect(Object.values(MODELS)).not.toContain(HAIKU)
    expect(MODELS.extraction).toBe('claude-sonnet-5-5')
    expect(thinkingParam('claude-sonnet-5-5', { type: 'disabled' })).toEqual({ type: 'between_tools' })
    expect(thinkingParam('claude-haiku-4-5-20251001', { type: 'disabled' })).toEqual({ type: 'disabled' })
    expect(CURRENT_EXTRACTION_VERSION).toBe('2026-10-17.result-context-v4')
  })
  it('already supported models are delegated to the shared routines unchanged', () => {
    const usage = { input_tokens: 11481, output_tokens: 2321, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard', inference_geo: 'global' }
    for (const model of SUPPORTED_MODELS) {
      expect(isEvalOnlyModel(model)).toBe(false)
      expect(isEvalPricedModel(model)).toBe(true)
      expect(evalPriceUsage(model, usage)).toEqual(priceUsage(model, usage))
      expect(evalContextWindowTokens(model)).toBe(PRICES[model].contextWindowTokens)
      const bound = { maxInputTokens: PRICES[model].contextWindowTokens, maxOutputTokens: 8192 }
      expect(evalMaxChargeMicro(model, bound)).toBe(maxChargeMicro(model, bound))
      expect(evalChargeBoundBasis(model, bound)).toMatch(/at list price$/)
    }
    // The 2026-10-10 Sonnet baseline charge is still reproduced exactly.
    expect(evalPriceUsage('claude-sonnet-5-5', usage).micro).toBe(46172)
    expect(evalPriceUsage('claude-unknown', usage)).toEqual({ ok: false, reason: 'unknown_model' })
    expect(() => evalMaxChargeMicro('claude-unknown', { maxInputTokens: 1, maxOutputTokens: 1 })).toThrow(/No price/)
    expect(evalContextWindowTokens('claude-unknown')).toBeNull()
  })
})

describe('conservative pre-dispatch bound', () => {
  it('full context plus the harness output limit, at the long-prompt rate: exactly $0.520480', () => {
    const micro = evalMaxChargeMicro(HAIKU, { maxInputTokens: 1_000_000, maxOutputTokens: 8192 })
    expect(micro).toBe(520_480)
    expect(micro / M).toBe(0.52048)
    expect(micro / M).toBeLessThanOrEqual(0.53)
    expect(evalChargeBoundBasis(HAIKU, { maxInputTokens: 1_000_000, maxOutputTokens: 8192 })).toBe('context window (1000000 input tokens) + max_tokens (8192) at the over-100000-token prompt list price (eval-only table)')
  })
  it('the bound switches tier just past the threshold and never rounds down', () => {
    expect(evalMaxChargeMicro(HAIKU, { maxInputTokens: 99_999, maxOutputTokens: 8192 })).toBe(Math.ceil((99_999 * 100_000 + 8192 * 500_000) / M))
    expect(evalMaxChargeMicro(HAIKU, { maxInputTokens: 100_000, maxOutputTokens: 8192 })).toBe(10_000 + 4_096)
    expect(evalMaxChargeMicro(HAIKU, { maxInputTokens: 100_001, maxOutputTokens: 8192 })).toBe(Math.ceil((100_001 * 500_000 + 8192 * 2_500_000) / M))
    expect(evalMaxChargeMicro(HAIKU, { maxInputTokens: 1, maxOutputTokens: 0 })).toBe(1)
  })
  it('refuses token bounds that are not non-negative integers', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, '10', null, undefined]) {
      expect(() => evalMaxChargeMicro(HAIKU, { maxInputTokens: bad, maxOutputTokens: 1 })).toThrow(/non-negative integers/)
      expect(() => evalMaxChargeMicro(HAIKU, { maxInputTokens: 1, maxOutputTokens: bad })).toThrow(/non-negative integers/)
    }
  })
})

describe('usage settlement picks the tier from the whole prompt', () => {
  const base = { output_tokens: 2000, service_tier: 'standard', inference_geo: 'global' }
  const standard = (input, output) => Math.ceil((input * 100_000 + output * 500_000) / M)
  const long = (input, output) => Math.ceil((input * 500_000 + output * 2_500_000) / M)

  it('99,999 and 100,000 input tokens pay the standard rate; 100,001 pays the long rate on every token', () => {
    expect(evalPriceUsage(HAIKU, { ...base, input_tokens: 99_999 })).toMatchObject({ ok: true, micro: standard(99_999, 2000), promptTier: 'standard', promptTokens: 99_999 })
    expect(evalPriceUsage(HAIKU, { ...base, input_tokens: 100_000 })).toMatchObject({ ok: true, micro: 11_000, promptTier: 'standard' })
    const over = evalPriceUsage(HAIKU, { ...base, input_tokens: 100_001 })
    expect(over).toMatchObject({ ok: true, micro: long(100_001, 2000), promptTier: 'long', promptTokens: 100_001 })
    // Not marginal pricing: one extra token moves the whole request, output included.
    expect(over.micro).toBe(55_001)
    expect(promptTier(SPEC, 100_000)).toBe('standard')
    expect(promptTier(SPEC, 100_001)).toBe('long')
  })
  it('cache reads and cache writes count toward the threshold', () => {
    const split = { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 10_000 }
    const at = evalPriceUsage(HAIKU, { ...base, input_tokens: 40_000, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 30_000, cache_creation: split })
    expect(at).toMatchObject({ ok: true, promptTier: 'standard', promptTokens: 100_000 })
    expect(at.micro).toBe(Math.ceil((40_000 * 100_000 + 20_000 * 125_000 + 10_000 * 200_000 + 30_000 * 10_000 + 2000 * 500_000) / M))
    const over = evalPriceUsage(HAIKU, { ...base, input_tokens: 40_001, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 30_000, cache_creation: split })
    expect(over).toMatchObject({ ok: true, promptTier: 'long', promptTokens: 100_001 })
    expect(over.micro).toBe(Math.ceil((40_001 * 500_000 + 20_000 * 625_000 + 10_000 * 1_000_000 + 30_000 * 50_000 + 2000 * 2_500_000) / M))
    // Uncached input alone is far below the threshold; a cache hit does not keep the low rate.
    expect(evalPriceUsage(HAIKU, { ...base, input_tokens: 1, cache_read_input_tokens: 100_000 }).promptTier).toBe('long')
    expect(evalPriceUsage(HAIKU, { ...base, input_tokens: 1, cache_creation_input_tokens: 100_000 }).promptTier).toBe('long')
  })
  it('cache writes without a complete per-TTL breakdown are priced at the 1-hour rate', () => {
    const noBreakdown = evalPriceUsage(HAIKU, { ...base, input_tokens: 1000, cache_creation_input_tokens: 5000 })
    expect(noBreakdown.micro).toBe(Math.ceil((1000 * 100_000 + 5000 * 200_000 + 2000 * 500_000) / M))
    const partial = evalPriceUsage(HAIKU, { ...base, input_tokens: 1000, cache_creation_input_tokens: 5000, cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 0 } })
    expect(partial.micro).toBe(noBreakdown.micro)
    const exact = evalPriceUsage(HAIKU, { ...base, input_tokens: 1000, cache_creation_input_tokens: 5000, cache_creation: { ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 0 } })
    expect(exact.micro).toBe(Math.ceil((1000 * 100_000 + 5000 * 125_000 + 2000 * 500_000) / M))
    expect(exact.micro).toBeLessThan(noBreakdown.micro)
  })
  it('a real-shaped response is priced, including zero-valued cache fields and thinking details', () => {
    const usage = { input_tokens: 11481, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 2321, output_tokens_details: { thinking_tokens: 0 }, service_tier: 'standard', inference_geo: 'global' }
    expect(evalPriceUsage(HAIKU, usage)).toEqual({ ok: true, micro: Math.ceil((11481 * 100_000 + 2321 * 500_000) / M), tokens: { input: 11481, output: 2321, cacheRead: 0, cacheWrite: 0 }, promptTier: 'standard', promptTokens: 11481 })
  })
  it('unpriceable usage is refused with a reason, never priced at zero', () => {
    const ok = { input_tokens: 10, output_tokens: 10 }
    const cases = [
      [undefined, 'missing_usage'], [null, 'missing_usage'], ['usage', 'missing_usage'],
      [{}, 'malformed_usage'], [{ input_tokens: 10 }, 'malformed_usage'], [{ output_tokens: 10 }, 'malformed_usage'],
      [{ ...ok, input_tokens: -1 }, 'malformed_usage'], [{ ...ok, input_tokens: 1.5 }, 'malformed_usage'], [{ ...ok, input_tokens: '10' }, 'malformed_usage'],
      [{ ...ok, output_tokens: NaN }, 'malformed_usage'], [{ ...ok, output_tokens: Infinity }, 'malformed_usage'],
      [{ ...ok, cache_read_input_tokens: -5 }, 'malformed_usage'], [{ ...ok, cache_creation_input_tokens: 'x' }, 'malformed_usage'],
      [{ ...ok, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: -1 } }, 'malformed_usage'],
      [{ ...ok, input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 10 }, 'malformed_usage'],
      [{ ...ok, input_tokens: 1_000_001 }, 'prompt_exceeds_context_window'],
      [{ ...ok, server_tool_use: { web_search_requests: 1 } }, 'server_tool_use'],
      [{ ...ok, service_tier: 'priority' }, 'service_tier'], [{ ...ok, service_tier: 'batch' }, 'service_tier'],
      [{ ...ok, inference_geo: 'us' }, 'inference_geo'],
    ]
    for (const [usage, reason] of cases) {
      const priced = evalPriceUsage(HAIKU, usage)
      expect(priced).toEqual({ ok: false, reason })
      expect(priced.micro).toBeUndefined()
    }
    expect(evalPriceUsage(HAIKU, { ...ok, server_tool_use: { web_search_requests: 0 } }).ok).toBe(true)
  })
})

describe('thinking and effort are recorded, not equalized', () => {
  it('Haiku 5.5: disabled thinking at the default medium effort is the documented supported form', () => {
    expect(evalThinkingRecord(HAIKU, { thinkingRequested: { type: 'disabled' }, thinkingSent: { type: 'disabled' } })).toEqual({
      thinkingRequested: { type: 'disabled' },
      thinkingSent: { type: 'disabled' },
      effortSent: null,
      effectiveEffort: 'medium',
      effectiveEffortBasis: 'not sent; documented model default',
      thinkingDisabledSupported: true,
    })
    for (const effort of ['xhigh', 'max']) {
      expect(evalThinkingRecord(HAIKU, { thinkingSent: { type: 'disabled' }, effortSent: effort }).thinkingDisabledSupported).toBe(false)
    }
  })
  it('Sonnet 5.5: the record shows the different sent value and default', () => {
    expect(evalThinkingRecord('claude-sonnet-5-5', { thinkingRequested: { type: 'disabled' }, thinkingSent: { type: 'between_tools' } })).toEqual({
      thinkingRequested: { type: 'disabled' },
      thinkingSent: { type: 'between_tools' },
      effortSent: null,
      effectiveEffort: 'high',
      effectiveEffortBasis: 'not sent; documented model default',
    })
    expect(evalThinkingRecord('claude-unknown').effectiveEffort).toBeNull()
  })
})
