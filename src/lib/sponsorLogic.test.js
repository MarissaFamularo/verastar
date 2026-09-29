// The pure half of the sponsored proxy is tested here because the edge function itself
// runs on Deno. Anything that decides money or cache identity gets a case.
import { describe, it, expect } from 'vitest'
import {
  modelRates,
  costUsd,
  capReached,
  effectiveCaps,
  accountActive,
  windows,
  parseCacheHeader,
  validateRequest,
  cachedResponse,
  extractionFromResponse,
  localClock,
  digestGate,
} from '../../supabase/functions/model/logic.js'
import { modelRates as clientRates } from './anthropic.js'

describe('rates and cost', () => {
  it('mirrors the client ledger for the models the app uses', () => {
    const now = new Date('2026-09-17T12:00:00Z')
    for (const m of ['claude-sonnet-5', 'claude-haiku-4-5-20251001']) {
      expect(modelRates(m, now)).toEqual(clientRates(m, now))
    }
  })
  it('never bills an unknown model at zero', () => {
    expect(costUsd('claude-something-new', { input_tokens: 1_000_000 })).toBeGreaterThan(0)
  })
  it('charges cache reads at a tenth of input', () => {
    const now = new Date('2026-09-17T12:00:00Z')
    const full = costUsd('claude-sonnet-5', { input_tokens: 1_000_000 }, now)
    const cached = costUsd('claude-sonnet-5', { cache_read_input_tokens: 1_000_000 }, now)
    expect(cached).toBeCloseTo(full / 10, 9)
  })
})

describe('caps', () => {
  const caps = { dailyCapUsd: 1.5, monthlyCapUsd: 25, globalMonthlyCeilingUsd: 1500 }
  it('allows under every cap', () => {
    expect(capReached({ spentToday: 1.49, spentMonth: 24, spentGlobalMonth: 100 }, caps)).toBeNull()
  })
  it('stops at the daily cap', () => {
    expect(capReached({ spentToday: 1.5, spentMonth: 5, spentGlobalMonth: 100 }, caps)).toBe('day')
  })
  it('stops at the monthly cap before the daily one is reached', () => {
    expect(capReached({ spentToday: 0.1, spentMonth: 25, spentGlobalMonth: 100 }, caps)).toBe('month')
  })
  it('the global ceiling wins over everything', () => {
    expect(capReached({ spentToday: 0, spentMonth: 0, spentGlobalMonth: 1500 }, caps)).toBe('global')
  })
  it('account overrides beat config defaults, nulls fall through', () => {
    const config = { default_daily_cap_usd: '1.5', default_monthly_cap_usd: '25', global_monthly_ceiling_usd: '1500' }
    expect(effectiveCaps({ daily_cap_usd: '3' }, config)).toEqual({ dailyCapUsd: 3, monthlyCapUsd: 25, globalMonthlyCeilingUsd: 1500 })
    expect(effectiveCaps({ daily_cap_usd: null, monthly_cap_usd: null }, config)).toEqual({ dailyCapUsd: 1.5, monthlyCapUsd: 25, globalMonthlyCeilingUsd: 1500 })
  })
  it('an inactive or expired account is not sponsored', () => {
    const now = new Date('2026-09-17T12:00:00Z')
    expect(accountActive(null, now)).toBe(false)
    expect(accountActive({ active: false }, now)).toBe(false)
    expect(accountActive({ active: true, ends_at: '2026-09-01T00:00:00Z' }, now)).toBe(false)
    expect(accountActive({ active: true, ends_at: '2026-12-01T00:00:00Z' }, now)).toBe(true)
    expect(accountActive({ active: true, ends_at: null }, now)).toBe(true)
  })
  it('windows reset at UTC midnight and month start', () => {
    expect(windows(new Date('2026-09-17T23:59:00Z'))).toEqual({ dayStart: '2026-09-17T00:00:00.000Z', monthStart: '2026-09-01T00:00:00.000Z' })
  })
})

describe('cache header', () => {
  const hash = 'a'.repeat(64)
  it('parses a well-formed key', () => {
    expect(parseCacheHeader(`39993822|2026-09-11.relationships-v1|${hash.toUpperCase()}|full_text`)).toEqual({
      pmid: '39993822', extraction_version: '2026-09-11.relationships-v1', source_hash: hash, source_tier: 'full_text',
    })
  })
  it('rejects malformed keys as no-cache rather than erroring', () => {
    expect(parseCacheHeader('')).toBeNull()
    expect(parseCacheHeader('a|b|c')).toBeNull()
    expect(parseCacheHeader(`x|v|nothex|full_text`)).toBeNull()
    expect(parseCacheHeader(`x|v|${hash}|pdf`)).toBeNull()
  })
})

describe('request validation and cache responses', () => {
  const ok = { model: 'claude-sonnet-5', max_tokens: 4096, messages: [{ role: 'user', content: 'x' }] }
  it('accepts the shape the app sends', () => {
    expect(validateRequest(ok)).toBeNull()
  })
  it('rejects streaming, non-Claude models, and absurd max_tokens', () => {
    expect(validateRequest({ ...ok, stream: true })).toMatch(/Streaming/)
    expect(validateRequest({ ...ok, model: 'gpt-4' })).toMatch(/Claude/)
    expect(validateRequest({ ...ok, max_tokens: 999999 })).toMatch(/max_tokens/)
  })
  it('a cached row becomes a clean end_turn response with zero usage', () => {
    const res = cachedResponse({ source_hash: 'b'.repeat(64), extraction: { study_id: 'x', quantities: [] }, model: 'claude-sonnet-5' }, 'claude-sonnet-5')
    expect(res.stop_reason).toBe('end_turn')
    expect(res.usage.input_tokens).toBe(0)
    expect(JSON.parse(res.content[0].text)).toEqual({ study_id: 'x', quantities: [] })
  })
  it('only a clean, parseable end_turn response is cached', () => {
    expect(extractionFromResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 })
    expect(extractionFromResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }] })).toBeNull()
    expect(extractionFromResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'nope' }] })).toBeNull()
  })
})

describe('digest scheduler gate', () => {
  const base = { hour: 5, hourLocal: 5 }

  it('runs at her hour when the last digest was opened', () => {
    expect(digestGate({ ...base, mayRun: true })).toEqual({ run: true })
  })

  it('waits before her hour', () => {
    expect(digestGate({ ...base, hour: 4 })).toEqual({ run: false, reason: 'not yet' })
  })

  it('catches up later the same day once the unopened digest is opened (2026-09-28)', () => {
    // 5am: Sunday's digest still unopened, so the morning is skipped.
    expect(digestGate({ ...base, mayRun: false })).toEqual({ run: false, reason: 'last digest unopened' })
    // 6:35am: she opened it at 6:34; the next tick runs instead of waiting for tomorrow.
    expect(digestGate({ ...base, hour: 6, mayRun: true })).toEqual({ run: true })
  })

  it('never runs twice in a day or over a digest from today', () => {
    expect(digestGate({ ...base, hour: 9, ranToday: true })).toEqual({ run: false, reason: 'already ran today' })
    expect(digestGate({ ...base, hour: 9, savedToday: true })).toEqual({ run: false, reason: "today's digest already exists" })
    expect(digestGate({ ...base, manual: true, savedToday: true })).toEqual({ run: false, reason: "today's digest already exists" })
  })

  it('continues a run that is partway through, whatever the hour', () => {
    expect(digestGate({ ...base, hour: 7, midFlight: true, ranToday: true, savedToday: true, mayRun: true })).toEqual({ run: true })
  })

  it('a manual run ignores the hour and the opened gate', () => {
    expect(digestGate({ ...base, hour: 2, manual: true, mayRun: false })).toEqual({ run: true })
  })

  it('nobody runs while another tick holds a fresh claim, manual included', () => {
    expect(digestGate({ ...base, claimedFresh: true })).toEqual({ run: false, reason: 'already running' })
    expect(digestGate({ ...base, manual: true, claimedFresh: true })).toEqual({ run: false, reason: 'already running' })
  })
})

describe('localClock', () => {
  it('reads the hour and day in the account timezone', () => {
    expect(localClock(new Date('2026-09-28T09:00:05Z'), 'America/New_York')).toEqual({ hour: 5, day: '2026-09-28' })
    expect(localClock(new Date('2026-09-28T03:30:00Z'), 'America/New_York')).toEqual({ hour: 23, day: '2026-09-27' })
  })

  it('falls back to UTC for an unknown timezone', () => {
    expect(localClock(new Date('2026-09-28T09:00:05Z'), 'Not/AZone')).toEqual({ hour: 9, day: '2026-09-28' })
  })
})
