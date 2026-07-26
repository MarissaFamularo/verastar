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

import {
  saveDailyDigest,
  loadDailyDigest,
  clearDailyDigest,
  serializeDigest,
  reviveDigest,
  withOaLinks,
  digestGaps,
  restoreNote,
} from './digestStore.js'
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

// The honesty check on a rehydrated digest. Every result needs a triage entry — that's where
// the finding and relevance come from — so a result without one is a card with no summary,
// and the restore line has to say so instead of reading like a normal morning.
describe('digestGaps', () => {
  const res = (id, extra = {}) => ({ paper: { id, pmid: id }, rows: [], ...extra })

  it('calls a fully-triaged digest complete', () => {
    const gaps = digestGaps({ results: [res('1'), res('2')], triaged: { 1: { score: 9 }, 2: { score: 4 } } })
    expect(gaps).toEqual({ total: 2, missing: 0, complete: true })
  })

  it('counts the results with no triage entry', () => {
    const gaps = digestGaps({ results: [res('1'), res('2'), res('3')], triaged: { 2: { score: 4 } } })
    expect(gaps).toEqual({ total: 3, missing: 2, complete: false })
  })

  it('treats an empty triage map as every result missing (the mid-run snapshot)', () => {
    const gaps = digestGaps({ results: [res('1'), res('2')], triaged: {} })
    expect(gaps).toEqual({ total: 2, missing: 2, complete: false })
  })

  it('does not count papers that errored — they never reach triage', () => {
    const gaps = digestGaps({ results: [res('1'), res('2', { error: 'fetch failed' })], triaged: { 1: { score: 9 } } })
    expect(gaps).toEqual({ total: 2, missing: 0, complete: true })
  })

  it('is complete for an empty digest (a candidates-only restore)', () => {
    expect(digestGaps({ results: [], triaged: {} })).toEqual({ total: 0, missing: 0, complete: true })
  })

  it('survives malformed input', () => {
    expect(digestGaps(null)).toEqual({ total: 0, missing: 0, complete: true })
    expect(digestGaps({})).toEqual({ total: 0, missing: 0, complete: true })
    expect(digestGaps({ results: 'nope', triaged: 'nope' })).toEqual({ total: 0, missing: 0, complete: true })
    // No id to look up, so nothing can be claimed about it.
    expect(digestGaps({ results: [{}, null], triaged: {} })).toEqual({ total: 2, missing: 0, complete: true })
  })

  it('does not mistake an inherited Object property for a triage entry', () => {
    expect(digestGaps({ results: [res('toString')], triaged: {} }).missing).toBe(1)
  })

  it('counts a triaged paper whose summary the prose gate refuted as present', () => {
    // A refuted finding is withheld at render time, but the ranking step DID run — that is a
    // deliberate withholding, not a gap, and must not be reported as a missing summary.
    const gaps = digestGaps({ results: [res('1')], triaged: { 1: { finding: 'x', check: { verdict: 'refuted' } } } })
    expect(gaps.complete).toBe(true)
  })
})

describe('restoreNote', () => {
  it('keeps the plain line for a complete restore', () => {
    expect(restoreNote(digestGaps({ results: [], triaged: {} }))).toBe('Restored your last digest — run again for fresh results.')
    expect(restoreNote()).toMatch(/^Restored your last digest — run again/)
  })

  it('states the gap, singular and plural', () => {
    expect(restoreNote({ missing: 1 })).toBe(
      "Restored your last digest — 1 paper has no summary (the ranking step didn't finish). Run again for fresh results.",
    )
    expect(restoreNote({ missing: 4 })).toContain('4 papers have no summary')
  })
})

// A run persists once, from the array it collected paper-by-paper — which predates the
// Unpaywall links resolved alongside it. Without the merge, a restored digest loses every
// free-full-text link and the read-the-paper-first workflow breaks.
describe('withOaLinks', () => {
  const results = [
    { paper: { id: '1' }, citation: { doi: '10.1/a' } },
    { paper: { id: '2' }, citation: { doi: '10.1/b' } },
  ]

  it('applies resolved links by paper id', () => {
    const merged = withOaLinks(results, new Map([['1', { url: 'https://x/a.pdf', isPdf: true }]]))
    expect(merged[0].oa).toEqual({ url: 'https://x/a.pdf', isPdf: true })
    expect(merged[1].oa).toBeUndefined()
  })

  it('keeps a resolved miss as null so the link is never re-attempted', () => {
    expect(withOaLinks(results, new Map([['2', null]]))[1].oa).toBeNull()
  })

  it('never overwrites an oa field the result already carries', () => {
    const already = [{ paper: { id: '1' }, oa: null }]
    expect(withOaLinks(already, new Map([['1', { url: 'https://x/a.pdf' }]]))[0].oa).toBeNull()
  })

  it('returns the same array when there is nothing to merge, and tolerates junk', () => {
    expect(withOaLinks(results, new Map())).toBe(results)
    expect(withOaLinks(results, undefined)).toBe(results)
    expect(withOaLinks(undefined, new Map([['1', null]]))).toEqual([])
    expect(withOaLinks([null, {}], new Map([['1', null]]))).toEqual([null, {}])
  })

  it('round-trips through the store', async () => {
    const state = { ...snapshot(), results: withOaLinks(snapshot().results, new Map([['111', { url: 'https://x/a.pdf' }]])) }
    await saveDailyDigest(state)
    const loaded = await loadDailyDigest()
    expect(loaded.results[0].oa).toEqual({ url: 'https://x/a.pdf' })
  })
})
