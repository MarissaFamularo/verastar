// drain.test.js — the vault drain's pure core. Locks the rules that make the
// drain safe: stale detection is derived from data (no queue), stamps make a
// second drain a no-op even under phone/desktop clock skew, and daily-digest UI
// state can never masquerade as a vault note.

import { describe, it, expect } from 'vitest'
import { recordBasis, needsVaultWrite, stampVaultWritten, computeDrain, weekendKey } from './drain.js'

const T1 = '2026-07-20T09:00:00.000Z'
const T2 = '2026-07-21T09:00:00.000Z'
const T3 = '2026-07-22T09:00:00.000Z'

describe('recordBasis', () => {
  it('prefers savedAt (papers), falls back to createdAt (weekend reads)', () => {
    expect(recordBasis({ savedAt: T1 })).toBe(T1)
    expect(recordBasis({ createdAt: T2 })).toBe(T2)
    expect(recordBasis({ savedAt: T1, createdAt: T2 })).toBe(T1)
    expect(recordBasis({})).toBe(null)
    expect(recordBasis(null)).toBe(null)
  })
})

describe('needsVaultWrite', () => {
  it('flags a record that was never written to the vault', () => {
    expect(needsVaultWrite({ savedAt: T1 })).toBe(true)
  })

  it('flags a stamp older than the record’s own save time', () => {
    expect(needsVaultWrite({ savedAt: T2, vaultWrittenAt: T1 })).toBe(true)
  })

  it('passes a stamp at or after the save time', () => {
    expect(needsVaultWrite({ savedAt: T1, vaultWrittenAt: T1 })).toBe(false)
    expect(needsVaultWrite({ savedAt: T1, vaultWrittenAt: T2 })).toBe(false)
  })

  it('never flags a stamped record with no basis, and never flags nothing', () => {
    expect(needsVaultWrite({ vaultWrittenAt: T1 })).toBe(false)
    expect(needsVaultWrite(null)).toBe(false)
    expect(needsVaultWrite(undefined)).toBe(false)
  })

  it('flags a legacy record with neither stamp nor basis (better a rewrite than a hole)', () => {
    expect(needsVaultWrite({ id: 'old' })).toBe(true)
  })
})

describe('stampVaultWritten', () => {
  it('stamps with now and preserves every other field', () => {
    const stamped = stampVaultWritten({ id: 'p1', savedAt: T1, title: 'X' }, T2)
    expect(stamped).toEqual({ id: 'p1', savedAt: T1, title: 'X', vaultWrittenAt: T2 })
  })

  it('a stamped record is never stale again, even when the phone clock ran fast', () => {
    // Phone saved "in the future" relative to the desktop doing the drain.
    const future = { id: 'p1', savedAt: T3 }
    const stamped = stampVaultWritten(future, T2)
    expect(stamped.vaultWrittenAt).toBe(T3) // clamped up to the record's own basis
    expect(needsVaultWrite(stamped)).toBe(false)
  })

  it('does not mutate the input record', () => {
    const rec = { id: 'p1', savedAt: T1 }
    stampVaultWritten(rec, T2)
    expect(rec.vaultWrittenAt).toBeUndefined()
  })
})

describe('computeDrain', () => {
  const papers = [
    { id: 'a', savedAt: T1, conceptId: 'c1' }, // never written
    { id: 'b', savedAt: T1, vaultWrittenAt: T2 }, // already written
    { id: 'c', savedAt: T3, vaultWrittenAt: T2, conceptId: 'c2' }, // stale
    { id: 'd', savedAt: T1 }, // never written, unfiled (no concept)
  ]
  const digests = [
    { kind: 'daily', savedAt: T3 }, // daily UI state — never a vault note
    { type: 'weekend', createdAt: T3 }, // unwritten, newest
    { type: 'weekend', createdAt: T1 }, // unwritten, oldest
    { type: 'weekend', createdAt: T2, vaultWrittenAt: T2 }, // written
  ]

  it('selects exactly the missing/stale papers and their concepts', () => {
    const drain = computeDrain({ papers, digests })
    expect(drain.papers.map((p) => p.id)).toEqual(['a', 'c', 'd'])
    expect([...drain.conceptIds].sort()).toEqual(['c1', 'c2'])
  })

  it('selects only weekend reads, oldest first, and ignores daily digest state', () => {
    const drain = computeDrain({ papers, digests })
    expect(drain.weekends.map((w) => w.createdAt)).toEqual([T1, T3])
  })

  it('is idempotent: after stamping, a second drain finds nothing', () => {
    const first = computeDrain({ papers, digests })
    const stampedPapers = papers.map((p) => (first.papers.includes(p) ? stampVaultWritten(p, T2) : p))
    const stampedDigests = digests.map((d) => (first.weekends.includes(d) ? stampVaultWritten(d, T2) : d))
    const second = computeDrain({ papers: stampedPapers, digests: stampedDigests })
    expect(second.papers).toEqual([])
    expect(second.weekends).toEqual([])
    expect(second.conceptIds.size).toBe(0)
  })

  it('tolerates empty and missing inputs', () => {
    expect(computeDrain({})).toEqual({ papers: [], weekends: [], conceptIds: new Set() })
    expect(computeDrain()).toEqual({ papers: [], weekends: [], conceptIds: new Set() })
  })
})

describe('weekendKey', () => {
  it('derives the day-keyed store slot from createdAt', () => {
    expect(weekendKey({ createdAt: '2026-07-21T18:30:00.000Z' })).toBe('weekend:2026-07-21')
  })
})
