import { describe, it, expect } from 'vitest'
import { sha256Hex, cacheKeyHeader } from './evidenceCache.js'
import { parseCacheHeader } from '../../supabase/functions/model/logic.js'
import { CURRENT_EXTRACTION_VERSION } from '../lib/evidenceVersion.js'

describe('source hashing', () => {
  it('is deterministic and sensitive to a single character', async () => {
    const a = await sha256Hex('HR 0.84 (97.5% CI 0.61–1.16)')
    const b = await sha256Hex('HR 0.84 (97.5% CI 0.61–1.16)')
    const c = await sha256Hex('HR 0.85 (97.5% CI 0.61–1.16)')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('cache key header', () => {
  it('round-trips through the proxy parser', async () => {
    const hash = await sha256Hex('body')
    const header = cacheKeyHeader({ pmid: '39993822', hash, tier: 'full_text' })
    expect(parseCacheHeader(header)).toEqual({
      pmid: '39993822', extraction_version: CURRENT_EXTRACTION_VERSION, source_hash: hash, source_tier: 'full_text',
    })
  })
  it('refuses to build a key it cannot vouch for', () => {
    expect(cacheKeyHeader({ pmid: '', hash: 'a'.repeat(64), tier: 'full_text' })).toBeNull()
    expect(cacheKeyHeader({ pmid: '1', hash: 'short', tier: 'full_text' })).toBeNull()
    expect(cacheKeyHeader({ pmid: '1', hash: 'a'.repeat(64), tier: 'pdf' })).toBeNull()
  })
})
