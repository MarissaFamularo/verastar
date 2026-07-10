// digestStore.test.js — the daily-digest persistence slot. Locks the record design:
// key 'daily:latest' in 'digests', kind:'daily', selectedIds as array on disk / Set in the
// app, and invisibility to WeekendRead's type==='weekend' scan of the same collection.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory fake for the store module — tests run in node, no IndexedDB.
vi.mock('./store.js', () => {
  const data = new Map()
  const k = (collection, key) => `${collection}:${key}`
  return {
    __data: data,
    store: {
      get: async (collection, key) => data.get(k(collection, key)),
      put: async (collection, key, value) => void data.set(k(collection, key), value),
      delete: async (collection, key) => void data.delete(k(collection, key)),
      all: async (collection) =>
        [...data.entries()].filter(([key]) => key.startsWith(`${collection}:`)).map(([, v]) => v),
      clear: async (collection) => {
        for (const key of [...data.keys()]) if (key.startsWith(`${collection}:`)) data.delete(key)
      },
    },
  }
})

import { saveDailyDigest, loadDailyDigest, clearDailyDigest, serializeDigest, reviveDigest } from './digestStore.js'
import { store, __data } from './store.js'

// A digest snapshot shaped like SpineCheck's state: runPaper results (incl. sourceDoc),
// triage map, candidate stubs, Set of selected ids.
const snapshot = () => ({
  results: [
    {
      paper: { id: '111', pmid: '111', title: 'BASIL-3' },
      citation: { pmid: '111', url: 'https://pubmed.ncbi.nlm.nih.gov/111/', verified: true },
      design: 'RCT',
      source: { tier: 'full_text', hasBody: true, pmcid: 'PMC1' },
      sourceDoc: { text: 'HR 0.84 in prose', tables: 'HR 0.84' },
      rows: [{ quantity: { name: 'HR', value: 0.84 }, verdict: { found: true, tier: 'verified-full-text', flagged: false } }],
    },
  ],
  triaged: { 111: { score: 88, tier: 1, finding: 'No difference.', relevance: 'CLTI project.' } },
  candidates: [{ id: '111', pmid: '111', title: 'BASIL-3', score: 88 }],
  selectedIds: new Set(['111', '222']),
})

beforeEach(() => __data.clear())

describe('daily digest round-trip', () => {
  it('returns null when nothing is saved', async () => {
    expect(await loadDailyDigest()).toBeNull()
  })

  it('preserves results, triaged, and candidates exactly', async () => {
    const state = snapshot()
    await saveDailyDigest(state)
    const loaded = await loadDailyDigest()
    expect(loaded.results).toEqual(state.results)
    expect(loaded.triaged).toEqual(state.triaged)
    expect(loaded.candidates).toEqual(state.candidates)
  })

  it('revives selectedIds as a Set', async () => {
    await saveDailyDigest(snapshot())
    const loaded = await loadDailyDigest()
    expect(loaded.selectedIds).toBeInstanceOf(Set)
    expect([...loaded.selectedIds].sort()).toEqual(['111', '222'])
  })

  it('clearDailyDigest empties the slot', async () => {
    await saveDailyDigest(snapshot())
    await clearDailyDigest()
    expect(await loadDailyDigest()).toBeNull()
  })

  it('tolerates a missing/empty snapshot', async () => {
    await saveDailyDigest({})
    const loaded = await loadDailyDigest()
    expect(loaded.results).toEqual([])
    expect(loaded.triaged).toEqual({})
    expect(loaded.candidates).toEqual([])
    expect(loaded.selectedIds.size).toBe(0)
  })
})

describe('record design', () => {
  it("writes kind:'daily' + ISO savedAt under digests/'daily:latest', selectedIds as array", async () => {
    await saveDailyDigest(snapshot())
    const record = await store.get('digests', 'daily:latest')
    expect(record.kind).toBe('daily')
    expect(Array.isArray(record.selectedIds)).toBe(true)
    expect(new Date(record.savedAt).toISOString()).toBe(record.savedAt)
  })

  it("is invisible to WeekendRead's scan (filters type==='weekend' && read)", async () => {
    await saveDailyDigest(snapshot())
    // A real weekend read record, as WeekendRead writes it (keyed by day).
    await store.put('digests', 'weekend:2026-07-05', { type: 'weekend', createdAt: '2026-07-05T00:00:00Z', read: { opener: 'x' } })
    const digests = await store.all('digests')
    const weekendView = digests.filter((d) => d?.type === 'weekend' && d?.read)
    expect(weekendView).toHaveLength(1)
    expect(weekendView[0].type).toBe('weekend')
  })

  it('reviveDigest rejects records that are not the daily digest', () => {
    expect(reviveDigest(undefined)).toBeNull()
    expect(reviveDigest({ type: 'weekend', read: {} })).toBeNull()
  })

  it('serializeDigest never emits a `type` field (reserved by WeekendRead)', () => {
    expect('type' in serializeDigest(snapshot())).toBe(false)
  })
})
