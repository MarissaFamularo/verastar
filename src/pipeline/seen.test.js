// seen.test.js — the cross-day dedup ledger. Locks the three properties the digest
// leans on: a damaged ledger degrades to "show everything" instead of throwing, a
// stamp is first-seen and never refreshed, and eviction is deterministic so the same
// papers don't fall out of the ledger differently on every read.

import { describe, it, expect } from 'vitest'
import {
  candidateId,
  normalizeLedger,
  seenIds,
  filterUnseen,
  mergeSeen,
  capLedger,
  stampableIds,
  LEDGER_CAP,
  EMPTY_LEDGER,
} from './seen.js'

const T1 = '2026-07-20'
const T2 = '2026-07-21'
const T3 = '2026-07-22'

const cand = (pmid) => ({ id: pmid, pmid, title: `Paper ${pmid}` })

describe('candidateId', () => {
  it('reads pmid, falls back to the store key id, and stringifies numbers', () => {
    expect(candidateId({ pmid: '111', id: '111' })).toBe('111')
    expect(candidateId({ id: '222' })).toBe('222')
    expect(candidateId(333)).toBe('333')
    expect(candidateId('444')).toBe('444')
  })

  it('returns empty for anything without a usable id', () => {
    expect(candidateId({})).toBe('')
    expect(candidateId(null)).toBe('')
    expect(candidateId(undefined)).toBe('')
  })
})

describe('normalizeLedger', () => {
  it('passes a well-formed ledger through', () => {
    expect(normalizeLedger({ ids: { 111: T1 }, updatedAt: T1 })).toEqual({ ids: { 111: T1 }, updatedAt: T1 })
  })

  it('treats missing or malformed ledgers as empty instead of throwing', () => {
    for (const bad of [undefined, null, {}, 'nope', 42, { ids: null }, { ids: ['111'] }, { ids: 'x' }]) {
      expect(normalizeLedger(bad)).toEqual({ ids: {}, updatedAt: null })
    }
  })

  it('keeps an entry whose stamp is corrupt — the id still dedups', () => {
    const ledger = normalizeLedger({ ids: { 111: T1, 222: null, 333: { when: T2 } } })
    expect(Object.keys(ledger.ids)).toEqual(['111', '222', '333'])
    expect(ledger.ids['222']).toBe('')
    expect(ledger.ids['333']).toBe('')
  })

  it('drops a non-string updatedAt', () => {
    expect(normalizeLedger({ ids: {}, updatedAt: 12345 }).updatedAt).toBe(null)
  })
})

describe('seenIds', () => {
  it('returns the ledger keys as a set, empty for a broken ledger', () => {
    expect(seenIds({ ids: { 111: T1, 222: T2 } })).toEqual(new Set(['111', '222']))
    expect(seenIds(undefined)).toEqual(new Set())
  })
})

describe('filterUnseen', () => {
  const pool = [cand('111'), cand('222'), cand('333')]

  it('keeps only candidates in neither the ledger nor the library', () => {
    const kept = filterUnseen(pool, new Set(['111']), new Set(['333']))
    expect(kept.map((c) => c.pmid)).toEqual(['222'])
  })

  it('accepts library RECORDS as well as bare ids — saved papers key on id', () => {
    const kept = filterUnseen(pool, new Set(), [{ id: '222', savedAt: T1 }])
    expect(kept.map((c) => c.pmid)).toEqual(['111', '333'])
  })

  it('keeps everything when nothing has been seen', () => {
    expect(filterUnseen(pool, new Set(), new Set())).toHaveLength(3)
    expect(filterUnseen(pool, null, undefined)).toHaveLength(3)
  })

  it('returns an empty list when every candidate is already known', () => {
    expect(filterUnseen(pool, new Set(['111', '222', '333']), new Set())).toEqual([])
  })

  it('drops candidates with no id rather than passing an unidentifiable paper through', () => {
    expect(filterUnseen([{ title: 'no pmid' }, cand('111')], new Set(), new Set())).toHaveLength(1)
  })

  it('tolerates a missing candidate list', () => {
    expect(filterUnseen(undefined, new Set(), new Set())).toEqual([])
  })
})

describe('mergeSeen', () => {
  it('stamps new pmids with the run date', () => {
    const next = mergeSeen(EMPTY_LEDGER, ['111', '222'], T1)
    expect(next.ids).toEqual({ 111: T1, 222: T1 })
    expect(next.updatedAt).toBe(T1)
  })

  it('keeps the FIRST-seen stamp when a pmid is merged again', () => {
    const day1 = mergeSeen(EMPTY_LEDGER, ['111'], T1)
    const day2 = mergeSeen(day1, ['111', '222'], T2)
    expect(day2.ids['111']).toBe(T1)
    expect(day2.ids['222']).toBe(T2)
    expect(day2.updatedAt).toBe(T2)
  })

  it('accepts candidate objects, not just bare pmids', () => {
    expect(mergeSeen(EMPTY_LEDGER, [cand('111')], T1).ids).toEqual({ 111: T1 })
  })

  it('never mutates the ledger it was given', () => {
    const before = { ids: { 111: T1 }, updatedAt: T1 }
    mergeSeen(before, ['222'], T2)
    expect(before).toEqual({ ids: { 111: T1 }, updatedAt: T1 })
  })

  it('merges into a malformed ledger instead of throwing', () => {
    expect(mergeSeen('garbage', ['111'], T1).ids).toEqual({ 111: T1 })
    expect(mergeSeen(null, ['111'], T1).ids).toEqual({ 111: T1 })
  })

  it('ignores empty and unidentifiable entries', () => {
    expect(mergeSeen(EMPTY_LEDGER, ['111', '', null, {}], T1).ids).toEqual({ 111: T1 })
    expect(mergeSeen(EMPTY_LEDGER, undefined, T1).ids).toEqual({})
  })
})

describe('stampableIds', () => {
  const pool = [cand('111'), cand('222'), cand('333'), cand('444')]
  const ok = (id) => ({ id })
  const failed = (id) => ({ id, error: 'PubMed fetch failed' })

  it('stamps the papers that ran clean AND the ones she passed over in the funnel', () => {
    expect(stampableIds(pool, [ok('111'), ok('222')])).toEqual(['111', '222', '333', '444'])
  })

  it('never stamps a paper that errored — a network wobble must not bury it', () => {
    expect(stampableIds(pool, [ok('111'), failed('222')])).toEqual(['111', '333', '444'])
  })

  it('stamps NOTHING when every paper failed — that is not a digest she was shown', () => {
    expect(stampableIds(pool, [failed('111'), failed('222')])).toEqual([])
  })

  it('stamps nothing when no paper ran at all', () => {
    expect(stampableIds(pool, [])).toEqual([])
    expect(stampableIds(pool, undefined)).toEqual([])
  })

  it('needs only one success to stamp the papers she was offered', () => {
    expect(stampableIds(pool, [failed('111'), failed('222'), ok('333')])).toEqual(['333', '444'])
  })

  it('drops pool entries with no id', () => {
    expect(stampableIds([{ title: 'no pmid' }, cand('111')], [ok('111')])).toEqual(['111'])
  })

  it('tolerates a missing pool and malformed outcome entries', () => {
    expect(stampableIds(undefined, [ok('111')])).toEqual([])
    expect(stampableIds(pool, [null, ok('111')])).toEqual(['111', '222', '333', '444'])
  })

  it('feeds mergeSeen directly — the failed paper stays absent from the ledger', () => {
    const ledger = mergeSeen(EMPTY_LEDGER, stampableIds(pool, [ok('111'), failed('222')]), T1)
    expect(ledger.ids['222']).toBeUndefined()
    expect(Object.keys(ledger.ids)).toEqual(['111', '333', '444'])
  })
})

describe('capLedger', () => {
  it('leaves a ledger under the cap untouched', () => {
    const ledger = { ids: { 111: T1, 222: T2 }, updatedAt: T2 }
    expect(capLedger(ledger, 5)).toEqual(ledger)
  })

  it('evicts the oldest entries first', () => {
    const ledger = { ids: { 111: T1, 222: T2, 333: T3 }, updatedAt: T3 }
    expect(Object.keys(capLedger(ledger, 2).ids).sort()).toEqual(['222', '333'])
  })

  it('breaks stamp ties deterministically so repeated caps agree', () => {
    const ledger = { ids: { 111: T1, 222: T1, 333: T1 }, updatedAt: T1 }
    const once = Object.keys(capLedger(ledger, 2).ids)
    expect(once).toEqual(Object.keys(capLedger(ledger, 2).ids))
    expect(once).toHaveLength(2)
  })

  it('evicts corrupt-stamp entries before real ones', () => {
    const ledger = { ids: { 111: T1, 222: '', 333: T2 }, updatedAt: T2 }
    expect(Object.keys(capLedger(ledger, 2).ids).sort()).toEqual(['111', '333'])
  })

  it('defaults to the 5000 cap and holds a full year of daily runs', () => {
    const ids = {}
    for (let i = 0; i < LEDGER_CAP + 40; i++) ids[String(i).padStart(5, '0')] = T1
    const capped = capLedger({ ids, updatedAt: T1 })
    expect(Object.keys(capped.ids)).toHaveLength(LEDGER_CAP)
  })

  it('normalizes a malformed ledger rather than throwing', () => {
    expect(capLedger(undefined)).toEqual({ ids: {}, updatedAt: null })
    expect(capLedger({ ids: { 111: T1 } }, 'not a number')).toEqual({ ids: { 111: T1 }, updatedAt: null })
  })

  it('survives a merge → cap round trip without losing the newest day', () => {
    const merged = mergeSeen({ ids: { old: T1 }, updatedAt: T1 }, ['111', '222'], T3)
    const capped = capLedger(merged, 2)
    expect(Object.keys(capped.ids).sort()).toEqual(['111', '222'])
  })
})
