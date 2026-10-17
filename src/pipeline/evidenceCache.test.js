import { describe, it, expect, afterEach } from 'vitest'
import { sha256Hex, cacheKeyHeader, configureEvidenceCacheServer, storeCachedExtraction, lookupCachedExtraction, TRUSTED_CACHE_TABLE } from './evidenceCache.js'
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

describe('trusted cache boundary', () => {
  const PROV = { writer: 'digest-run', bundle_source_sha256: 'b'.repeat(64) }
  const writer = (row = null) => {
    const ops = []
    const chain = (table) => ({
      upsert: async (r, opts) => { ops.push({ table, op: 'upsert', row: r, opts }); return { error: null } },
      select: () => chain(table), eq: () => chain(table),
      maybeSingle: async () => { ops.push({ table, op: 'read' }); return { data: row, error: null } },
    })
    return { ops, client: { from: (table) => chain(table) } }
  }
  const good = { pmid: '1', hash: 'a'.repeat(64), tier: 'full_text', extraction: { study_id: '1', design: 'other', quantities: [], result_contexts: [] }, model: 'claude-sonnet-5-5' }
  afterEach(() => configureEvidenceCacheServer({}))

  it('the browser has no writer: a store is a no-op', async () => {
    expect(await storeCachedExtraction(good)).toBe(false)
  })
  it('a trusted server writer stores into the trusted table with server provenance, never overwriting', async () => {
    const w = writer()
    configureEvidenceCacheServer({ client: w.client, userId: 'acct-1', provenance: PROV })
    expect(await storeCachedExtraction(good)).toBe(true)
    expect(w.ops[0].table).toBe(TRUSTED_CACHE_TABLE)
    expect(w.ops[0].row).toMatchObject({ pmid: '1', extraction_version: CURRENT_EXTRACTION_VERSION, source_tier: 'full_text', created_by: 'acct-1', provenance: { ...PROV, extraction_version: CURRENT_EXTRACTION_VERSION, source_tier: 'full_text' } })
    expect(w.ops[0].opts).toEqual({ onConflict: 'pmid,extraction_version,source_hash', ignoreDuplicates: true })
  })
  it('refuses a writer without server provenance', async () => {
    for (const provenance of [null, { writer: 'browser', bundle_source_sha256: 'b'.repeat(64) }, { writer: 'digest-run' }]) {
      const w = writer()
      configureEvidenceCacheServer({ client: w.client, userId: 'acct-1', provenance })
      expect(await storeCachedExtraction(good)).toBe(false)
      expect(w.ops).toEqual([])
    }
  })
  it('refuses user-supplied text, other versions, and malformed hashes even with a trusted writer', async () => {
    const w = writer()
    configureEvidenceCacheServer({ client: w.client, userId: 'acct-1', provenance: PROV })
    expect(await storeCachedExtraction({ ...good, tier: 'user_text' })).toBe(false)
    expect(await storeCachedExtraction({ ...good, version: '2099-01-01.forged' })).toBe(false)
    expect(await storeCachedExtraction({ ...good, hash: 'not-a-hash' })).toBe(false)
    expect(w.ops).toEqual([])
  })
  it('lookups read only the trusted table, and a row without provenance is a miss', async () => {
    const trusted = writer({ extraction: { format: 'extraction-wire-v2', value: { study_id: '1', design: 'other', quantities: [], result_contexts: [] } }, model: 'm', source_tier: 'full_text', provenance: PROV })
    configureEvidenceCacheServer({ client: trusted.client, userId: 'acct-1', provenance: PROV })
    expect((await lookupCachedExtraction({ pmid: '1', hash: 'a'.repeat(64) }))?.extraction).toEqual({ study_id: '1', design: 'other', quantities: [], result_contexts: [] })
    // An untagged row (the pre-envelope representation) is a miss, never an inferred shape.
    const untagged = writer({ extraction: { study_id: '1', design: 'other', quantities: [], result_contexts: [] }, model: 'm', source_tier: 'full_text', provenance: PROV })
    configureEvidenceCacheServer({ client: untagged.client, userId: 'acct-1', provenance: PROV })
    expect(await lookupCachedExtraction({ pmid: '1', hash: 'a'.repeat(64) })).toBeNull()
    expect(trusted.ops.map((o) => o.table)).toEqual([TRUSTED_CACHE_TABLE])
    const legacy = writer({ extraction: { format: 'extraction-wire-v2', value: { study_id: '1', design: 'other', quantities: [], result_contexts: [] } }, model: 'm', source_tier: 'full_text' })
    configureEvidenceCacheServer({ client: legacy.client, userId: 'acct-1', provenance: PROV })
    expect(await lookupCachedExtraction({ pmid: '1', hash: 'a'.repeat(64) })).toBeNull()
  })
})
