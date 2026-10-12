// The pure half of the sponsored proxy is tested here because the edge function itself
// runs on Deno. Anything that decides money or cache identity gets a case.
import { describe, it, expect } from 'vitest'
import {
  accountActive,
  parseCacheHeader,
  cachedResponse,
  localClock,
  digestGate,
} from '../../supabase/functions/model/logic.js'

// Prices, request bounds and the cap decision moved out of this file on 2026-10-09: the
// cap decision is the spend_* database functions (supabase/tests/spending_contract.sql),
// prices are _shared/pricing.js (pricing.test.js), bounds are _shared/requestPolicy.js
// (requestPolicy.test.js), and the boundary is _shared/spending.js (spending.test.js).

describe('account activity', () => {
  it('an inactive or expired account is not sponsored', () => {
    const now = new Date('2026-09-17T12:00:00Z')
    expect(accountActive(null, now)).toBe(false)
    expect(accountActive({ active: false }, now)).toBe(false)
    expect(accountActive({ active: true, ends_at: '2026-09-01T00:00:00Z' }, now)).toBe(false)
    expect(accountActive({ active: true, ends_at: '2026-12-01T00:00:00Z' }, now)).toBe(true)
    expect(accountActive({ active: true, ends_at: null }, now)).toBe(true)
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

describe('cache responses', () => {
  it('a cached row becomes a clean end_turn response with zero usage', () => {
    const res = cachedResponse({ source_hash: 'b'.repeat(64), extraction: { study_id: 'x', quantities: [] }, model: 'claude-sonnet-5' }, 'claude-sonnet-5')
    expect(res.stop_reason).toBe('end_turn')
    expect(res.usage.input_tokens).toBe(0)
    expect(JSON.parse(res.content[0].text)).toEqual({ study_id: 'x', quantities: [] })
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
