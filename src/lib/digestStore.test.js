import { VERIFICATION_VERSION } from './evidenceVersion.js'
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
  digestDateLine,
  isDigestFromToday,
  sameDayNote,
  saveSuccessfulScan,
  loadSuccessfulScan,
  scheduledDigestStatus,
  isHeldRun,
  HELD_DIGEST_NOTE,
  ABANDONED_DIGEST_NOTE,
  frozenDigestState,
  createContinuationGate,
  digestControlPolicy,
  mayOverwriteDigest,
  saveDailyDigestIfCurrent,
  staleDigestReason,
  markDigestOpened,
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
      rows: [{ quantity: { name: 'HR', value: 0.84 }, verdict: { verificationVersion: VERIFICATION_VERSION, relationshipValidated: true, found: true, tier: 'verified-full-text', flagged: false } }],
    },
  ],
  processedResults: [
    { paper: { id: '111', pmid: '111', title: 'BASIL-3' }, rows: [] },
    { paper: { id: '222', pmid: '222', title: 'Below final bar but already read' }, rows: [] },
  ],
  triaged: { 111: { score: 88, tier: 1, finding: 'No difference.', relevance: 'CLTI project.' } },
  candidates: [{ id: '111', pmid: '111', title: 'BASIL-3', score: 88 }],
  preCapCandidates: [
    { id: '111', pmid: '111', title: 'BASIL-3', score: 88 },
    { id: '333', pmid: '333', title: 'Pre-scored before topic cap', score: 60 },
  ],
  searchContext: { counts: [{ label: 'CLTI', count: 1, available: 2, prescored: 2 }], failed: [], days: 7 },
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
    expect(loaded.processedResults).toEqual(state.processedResults)
    expect(loaded.triaged).toEqual(state.triaged)
    expect(loaded.candidates).toEqual(state.candidates)
    expect(loaded.preCapCandidates).toEqual(state.preCapCandidates)
    expect(loaded.searchContext).toEqual(state.searchContext)
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
    expect(loaded.processedResults).toEqual([])
    expect(loaded.triaged).toEqual({})
    expect(loaded.candidates).toEqual([])
    expect(loaded.selectedIds.size).toBe(0)
  })

  it('revives legacy snapshots by treating visible results as the paid-work cache', () => {
    const revived = reviveDigest({ kind: 'daily', results: [{ paper: { id: '1' } }] })
    expect(revived.processedResults).toEqual(revived.results)
    expect(revived.preCapCandidates).toEqual([])
    expect(revived.searchContext).toEqual({ counts: [], failed: [], days: null })
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

describe('successful scan checkpoint', () => {
  it('survives clearing the transient daily digest', async () => {
    await saveDailyDigest(snapshot())
    await saveSuccessfulScan({ completedAt: '2026-08-01T14:00:00.000Z', windowDays: 7 })
    await clearDailyDigest()

    expect(await loadDailyDigest()).toBeNull()
    expect(await loadSuccessfulScan()).toEqual({ completedAt: '2026-08-01T14:00:00.000Z', windowDays: 7 })
  })

  it('rejects a malformed or foreign checkpoint', async () => {
    await store.put('digests', 'daily:last-successful-scan', { kind: 'weekend', completedAt: '2026-08-01T14:00:00.000Z' })
    expect(await loadSuccessfulScan()).toBeNull()
    await store.put('digests', 'daily:last-successful-scan', { kind: 'daily-scan-checkpoint', completedAt: 'not-a-date' })
    expect(await loadSuccessfulScan()).toBeNull()
  })

  it('does not masquerade as a weekend read', async () => {
    await saveSuccessfulScan({ completedAt: '2026-08-01T14:00:00.000Z', windowDays: 3 })
    const weekendView = (await store.all('digests')).filter((d) => d?.type === 'weekend' && d?.read)
    expect(weekendView).toEqual([])
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

  it('counts a read-but-unranked paper held out of results (failed ranking after an append)', () => {
    const gaps = digestGaps({
      results: [res('1')],
      processedResults: [res('1'), res('2'), res('3', { error: 'fetch failed' }), res('4', { retracted: true })],
      triaged: { 1: { score: 9 } },
    })
    expect(gaps).toEqual({ total: 1, missing: 1, complete: false })
  })

  it('does not count a read paper the ranking scored below the bar', () => {
    const gaps = digestGaps({ results: [res('1')], processedResults: [res('1'), res('2')], triaged: { 1: { score: 9 }, 2: { score: 20 } } })
    expect(gaps.complete).toBe(true)
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
      "Restored your last digest — 1 paper has no summary (the run didn't finish). Finish it below to keep what's already verified, or run again for a fresh scan.",
    )
    expect(restoreNote({ missing: 4 })).toContain('4 papers have no summary')
  })

  // The gap line sits directly above the Finish button, so it must not send her to the
  // expensive remedy — a fresh scan re-pays for every paper already verified.
  it('points an incomplete restore at finishing, not at re-running', () => {
    expect(restoreNote({ missing: 2 })).toMatch(/Finish it below/)
    expect(restoreNote({ missing: 2 })).not.toMatch(/^Restored your last digest — run again/)
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

// digestDateLine — the header used to render `new Date()` unconditionally, so a digest
// restored from yesterday sat under today's date and read as this morning's work. These
// lock the calendar-day comparison (not elapsed hours) and the stale wording.
describe('digestDateLine', () => {
  const now = new Date(2026, 6, 29, 8, 0) // Wednesday, July 29, 2026, 8am local

  it('shows today when there is no digest at all', () => {
    expect(digestDateLine(null, now)).toEqual({ text: 'Wednesday, July 29, 2026', stale: false, days: 0 })
  })

  it("shows the full date, unstaled, for today's digest", () => {
    const line = digestDateLine(new Date(2026, 6, 29, 5, 30).toISOString(), now)
    expect(line).toEqual({ text: 'Wednesday, July 29, 2026', stale: false, days: 0 })
  })

  it("names yesterday's digest as yesterday, and flags it stale", () => {
    const line = digestDateLine(new Date(2026, 6, 28, 6, 0).toISOString(), now)
    expect(line.text).toBe("Yesterday's digest · Tuesday, July 28")
    expect(line.stale).toBe(true)
    expect(line.days).toBe(1)
  })

  it('counts days for an older digest', () => {
    const line = digestDateLine(new Date(2026, 6, 26, 6, 0).toISOString(), now)
    expect(line.text).toBe('3 days old · Sunday, July 26')
    expect(line.days).toBe(3)
  })

  // The case she actually hit: a run late one evening, read the next morning. Only ~8
  // hours elapsed, but it is unambiguously yesterday's digest.
  it('compares calendar days, not elapsed hours', () => {
    const lateLastNight = digestDateLine(new Date(2026, 6, 28, 23, 30).toISOString(), now)
    expect(lateLastNight.stale).toBe(true)
    expect(lateLastNight.days).toBe(1)

    // ...and the converse: 17 hours apart, same day, not stale.
    const readTonight = digestDateLine(new Date(2026, 6, 29, 6, 0).toISOString(), new Date(2026, 6, 29, 23, 0))
    expect(readTonight.stale).toBe(false)
  })

  it('treats a future timestamp (fast phone clock) as today, never a negative age', () => {
    const line = digestDateLine(new Date(2026, 6, 30, 2, 0).toISOString(), now)
    expect(line.stale).toBe(false)
    expect(line.days).toBe(0)
  })

  it('falls back to today on an unparseable timestamp', () => {
    expect(digestDateLine('not a date', now).text).toBe('Wednesday, July 29, 2026')
    expect(digestDateLine('not a date', now).stale).toBe(false)
  })
})

describe('legacy cached evidence policy', () => {
  it('downgrades runtime views without rewriting the saved source or the original verdict', () => {
    const oldVerdict = { tier: 'verified-full-text', flagged: false, found: true }
    const record = { kind: 'daily', results: [{ paper: { id: 'p' }, sourceDoc: { text: 'Original source' }, rows: [{ quantity: { value: 20 }, verdict: oldVerdict }] }] }
    const revived = reviveDigest(record)
    // Re-derived from the saved source: the quantity has no receipt there, so it is flagged.
    expect(revived.results[0].rows[0].verdict.flagged).toBe(true)
    expect(revived.results[0].sourceDoc.text).toBe('Original source')
    expect(oldVerdict.flagged).toBe(false)
    expect(record.results[0].rows[0].verdict.tier).toBe('verified-full-text')
  })
})

describe('restored digests use the current verifier', () => {
  const text = 'Short-term DAPT was associated with a reduction in the risk of bleeding (HR, 0.44; 95% CI, 0.34-0.55; P < .001).'
  const quantity = { name: 'Bleeding', quantity_type: 'single', value: 0.44, unit: 'HR', ci_low: 0.34, ci_high: 0.55, p_value: null, range_low: null, range_high: null, first_label: null, first_value: null, second_label: null, second_value: null, source_quote: 'reduction in the risk of bleeding (HR, 0.44; 95% CI, 0.34-0.55; P < .001)', location_hint: 'Results' }
  const saved = (verdict, sourceDoc = { text, tables: '' }) => ({ kind: 'daily', results: [{ paper: { id: 'p' }, source: { tier: 'abstract_only' }, sourceDoc, rows: [{ quantity, verdict }] }] })
  it('re-derives an older-version verdict from the saved source text', () => {
    const old = { verificationVersion: '2026-09-11.relationships-v1', tier: 'source-located', flagged: true, relationshipValidated: false }
    const verdict = reviveDigest(saved(old)).results[0].rows[0].verdict
    expect(verdict.tier).toBe('verified-estimate')
    expect(verdict.verificationVersion).toBe(VERIFICATION_VERSION)
    expect(verdict.sourceTier).toBe('abstract_only')
    expect(old.tier).toBe('source-located') // the saved record is never rewritten here
  })
  it('re-derives a wrong value as flagged, never trusting the old stamp', () => {
    const old = { verificationVersion: '2026-09-11.relationships-v1', tier: 'verified-full-text', flagged: false, relationshipValidated: true }
    const record = saved(old)
    record.results[0].rows[0].quantity = { ...quantity, value: 0.45 }
    expect(reviveDigest(record).results[0].rows[0].verdict.flagged).toBe(true)
  })
  it('keeps a current-version verdict exactly as saved', () => {
    const current = { verificationVersion: VERIFICATION_VERSION, tier: 'flagged', flagged: true, relationshipValidated: false }
    expect(reviveDigest(saved(current)).results[0].rows[0].verdict).toBe(current)
  })
  it('falls back to the read-time policy without saved source text', () => {
    const old = { verificationVersion: '2026-09-11.relationships-v1', tier: 'source-located', flagged: true }
    expect(reviveDigest(saved(old, null)).results[0].rows[0].verdict.tier).toBe('source-located')
  })
})

// A digest's day is the day its scan ran. savedAt moves on every write — on 2026-09-25 an
// open-access link landing on yesterday's restored digest re-dated it as today's, which
// put today's date over yesterday's papers and locked out the new scan.
describe('ranAt', () => {
  it('defaults to the write time for a fresh scan', () => {
    const r = serializeDigest({ results: [] })
    expect(r.ranAt).toBe(r.savedAt)
  })
  it('survives a later re-save', () => {
    const r = serializeDigest({ results: [], ranAt: '2026-09-24T12:00:00.000Z' })
    expect(r.ranAt).toBe('2026-09-24T12:00:00.000Z')
    expect(r.savedAt).not.toBe(r.ranAt)
    expect(isDigestFromToday(reviveDigest(r).ranAt, new Date(2026, 8, 25, 18, 0))).toBe(false)
  })
  it('falls back to savedAt for records written before ranAt existed', () => {
    expect(reviveDigest({ kind: 'daily', savedAt: '2026-09-20T09:00:00.000Z' }).ranAt).toBe('2026-09-20T09:00:00.000Z')
  })
})

// The screen's re-saves (a heart, an open-access link landing) must never write yesterday's
// digest back over the one the server started this morning.
describe('saving from the digest screen', () => {
  const yesterday = '2026-09-27T09:00:00.000Z'
  const today = '2026-09-28T10:40:00.000Z'

  it('refuses to replace a newer scan', () => {
    expect(mayOverwriteDigest({ kind: 'daily', ranAt: today }, yesterday)).toBe(false)
  })
  it('allows the same scan, an older one, or nothing stored', () => {
    expect(mayOverwriteDigest({ kind: 'daily', ranAt: yesterday }, yesterday)).toBe(true)
    expect(mayOverwriteDigest({ kind: 'daily', ranAt: yesterday }, today)).toBe(true)
    expect(mayOverwriteDigest(null, yesterday)).toBe(true)
  })
  it('never blocks on a record from before ranAt existed', () => {
    expect(mayOverwriteDigest({ kind: 'daily', savedAt: today }, yesterday)).toBe(true)
  })
  it('skips the write and leaves the newer digest in place', async () => {
    await saveDailyDigest({ ...snapshot(), runBy: 'scheduler', ranAt: today, server: { phase: 'reading' } })
    expect(await saveDailyDigestIfCurrent({ ...snapshot(), ranAt: yesterday })).toBe(false)
    const stored = await store.get('digests', 'daily:latest')
    expect(stored.ranAt).toBe(today)
    expect(stored.runBy).toBe('scheduler')
  })
  it('writes when the digest on screen is the current one', async () => {
    await saveDailyDigest({ ...snapshot(), ranAt: yesterday })
    expect(await saveDailyDigestIfCurrent({ ...snapshot(), ranAt: yesterday, openedAt: today })).toBe(true)
    expect((await store.get('digests', 'daily:latest')).openedAt).toBe(today)
  })
})

// The same-day guard. A second run on the same day deletes `daily:latest` and the seen
// ledger has already retired the first run's papers — one accidental click on 2026-09-15
// threw the morning's digest away. The guard compares local calendar days, like
// digestDateLine, so an early-morning digest stays locked until midnight, not 24 hours.
describe('isDigestFromToday', () => {
  const now = new Date(2026, 8, 15, 14, 0, 0)
  it('is true for a digest saved earlier today, even at 00:01', () => {
    expect(isDigestFromToday(new Date(2026, 8, 15, 0, 1).toISOString(), now)).toBe(true)
    expect(isDigestFromToday(new Date(2026, 8, 15, 13, 59).toISOString(), now)).toBe(true)
  })
  it('is false for yesterday, even 15 hours ago', () => {
    expect(isDigestFromToday(new Date(2026, 8, 14, 23, 0).toISOString(), now)).toBe(false)
  })
  it('treats a future stamp (fast phone clock) as today', () => {
    expect(isDigestFromToday(new Date(2026, 8, 16, 1, 0).toISOString(), now)).toBe(true)
  })
  it('never locks on a missing or unparseable stamp', () => {
    expect(isDigestFromToday(null, now)).toBe(false)
    expect(isDigestFromToday(undefined, now)).toBe(false)
    expect(isDigestFromToday('garbage', now)).toBe(false)
  })
})

describe('sameDayNote', () => {
  it('says the digest is here and offers no same-day rerun', () => {
    expect(sameDayNote()).toMatch(/already here/)
    expect(sameDayNote()).toMatch(/tomorrow/)
    expect(sameDayNote()).not.toMatch(/replace|discard|run again/i)
  })
})

// Signed in, the database refuses a browser write that would destroy newer digest state
// (migration 20261010120000_digest_write_guard.sql) and the cloud store surfaces it as an
// error carrying `digest_stale:<rule>`. These lock what the digest store does with that
// refusal; the refusal itself is tested against a real local database
// (evidence-eval/implementation/digest-race-20261010/race.mjs).
describe('a write the database refuses as stale', () => {
  const yesterday = '2026-10-09T09:00:00.000Z'
  const today = '2026-10-10T09:00:00.000Z'
  const refusal = (rule) => new Error(`Cloud write failed: digest_stale:${rule}`)
  const realPut = store.put
  const realDelete = store.delete
  beforeEach(() => {
    store.put = realPut
    store.delete = realDelete
  })

  it('names the rule, and is null for any other error', () => {
    expect(staleDigestReason(refusal('newer_digest'))).toBe('newer_digest')
    expect(staleDigestReason(new Error('Cloud delete failed: digest_stale:scheduler_running'))).toBe('scheduler_running')
    expect(staleDigestReason(new Error('Cloud write failed: network'))).toBeNull()
    expect(staleDigestReason(null)).toBeNull()
  })

  it('reports a refused save as false and leaves the stored digest alone', async () => {
    // The local check passes (the read saw yesterday); the scheduler saves today in between.
    await saveDailyDigest({ ...snapshot(), ranAt: yesterday })
    store.put = async () => {
      __data.set('digests:daily:latest', serializeDigest({ ...snapshot(), runBy: 'scheduler', ranAt: today, server: { phase: 'done' } }))
      throw refusal('newer_digest')
    }
    expect(await saveDailyDigestIfCurrent({ ...snapshot(), ranAt: yesterday })).toBe(false)
    expect((await store.get('digests', 'daily:latest')).ranAt).toBe(today)
  })

  it('still throws a save that failed for another reason', async () => {
    store.put = async () => { throw new Error('Cloud write failed: network') }
    await expect(saveDailyDigestIfCurrent({ ...snapshot(), ranAt: today })).rejects.toThrow(/network/)
  })

  it('stamps opened on the fresh record after a refused stamp, keeping what changed in between', async () => {
    await saveDailyDigest({ ...snapshot(), runBy: 'scheduler', ranAt: today, server: { phase: 'reading' } })
    let puts = 0
    store.put = async (collection, key, value) => {
      if (++puts === 1) {
        // The scheduler saved another paper after the stamp's read: the stale write is refused.
        const fresh = __data.get('digests:daily:latest')
        __data.set('digests:daily:latest', { ...fresh, results: [...fresh.results, { paper: { id: '999' }, rows: [] }] })
        throw refusal('scheduler_in_flight')
      }
      return realPut(collection, key, value)
    }
    expect(await markDigestOpened('2026-10-10T09:30:00.000Z', { ranAt: today })).toBe(true)
    const stored = await store.get('digests', 'daily:latest')
    expect(puts).toBe(2)
    expect(stored.openedAt).toBe('2026-10-10T09:30:00.000Z')
    expect(stored.results.map((r) => r.paper.id)).toContain('999')
  })

  it('does not stamp a different digest than the one that was shown', async () => {
    await saveDailyDigest({ ...snapshot(), ranAt: today })
    expect(await markDigestOpened('2026-10-10T09:30:00.000Z', { ranAt: yesterday })).toBe(false)
    expect((await store.get('digests', 'daily:latest')).openedAt).toBeNull()
  })

  it('stamps once without a named digest, as before', async () => {
    await saveDailyDigest({ ...snapshot(), ranAt: today })
    expect(await markDigestOpened('2026-10-10T09:30:00.000Z')).toBe(true)
    expect(await markDigestOpened('2026-10-10T10:30:00.000Z')).toBe(false)
    expect((await store.get('digests', 'daily:latest')).openedAt).toBe('2026-10-10T09:30:00.000Z')
  })

  it('gives up quietly when the stamp keeps being refused', async () => {
    await saveDailyDigest({ ...snapshot(), ranAt: today })
    let puts = 0
    store.put = async () => { puts++; throw refusal('scheduler_in_flight') }
    expect(await markDigestOpened('2026-10-10T09:30:00.000Z', { ranAt: today })).toBe(false)
    expect(puts).toBe(3)
  })

  it('reports a refused clear as false, a clear as true, and rethrows other failures', async () => {
    await saveDailyDigest({ ...snapshot(), runBy: 'scheduler', ranAt: today, server: { phase: 'reading' } })
    store.delete = async () => { throw new Error('Cloud delete failed: digest_stale:scheduler_running') }
    expect(await clearDailyDigest()).toBe(false)
    expect(await loadDailyDigest()).not.toBeNull()
    store.delete = async () => { throw new Error('Cloud delete failed: network') }
    await expect(clearDailyDigest()).rejects.toThrow(/network/)
    store.delete = realDelete
    expect(await clearDailyDigest()).toBe(true)
    expect(await loadDailyDigest()).toBeNull()
  })
})

describe('scheduled digests that did not simply finish', () => {
  const base = { kind: 'daily', runBy: 'scheduler', ranAt: '2026-10-10T10:00:00.000Z', results: [] }
  it('a held run says it is delayed, is still pending, and does not invite another start', () => {
    const s = scheduledDigestStatus({ ...base, server: { phase: 'reading', held: { reason: 'unresolved_liability', at: '2026-10-10T10:01:00.000Z' } } })
    expect(s).toMatchObject({ note: HELD_DIGEST_NOTE, pending: true, held: true, abandoned: false, delayed: true })
    expect(HELD_DIGEST_NOTE).toMatch(/delayed/)
    expect(HELD_DIGEST_NOTE).toMatch(/do not need to do anything/)
    expect(HELD_DIGEST_NOTE).not.toMatch(/try again|run again|retry/i)
    expect(HELD_DIGEST_NOTE).not.toMatch(/\d/) // number-free, like the rest of the digest prose
  })
  it('an abandoned run is shown as stopped, never as a prepared or finished digest', () => {
    const s = scheduledDigestStatus({ ...base, server: { phase: 'done', abandoned: true, held: { reason: 'unresolved_liability' } } })
    expect(s).toMatchObject({ note: ABANDONED_DIGEST_NOTE, pending: false, held: false, abandoned: true, delayed: true })
    expect(ABANDONED_DIGEST_NOTE).toMatch(/not a complete digest/)
    expect(ABANDONED_DIGEST_NOTE).not.toMatch(/prepared|ready/i)
  })
  it('an ordinary unfinished run and an ordinary finished one keep their existing lines', () => {
    expect(scheduledDigestStatus({ ...base, server: { phase: 'rank' } })).toMatchObject({ pending: true, held: false, delayed: false, note: expect.stringMatching(/still being prepared/) })
    const shown = { paper: { id: 'a' } }
    expect(scheduledDigestStatus({ ...base, results: [shown], processedResults: [shown], triaged: { a: { finding: 'ready' } }, server: { phase: 'rank' } })).toMatchObject({ pending: false, note: expect.not.stringMatching(/still being prepared/) })
    expect(scheduledDigestStatus({ ...base, results: [shown], processedResults: [shown], triaged: {}, server: { phase: 'rank' } }).note).toMatch(/papers are here/)
    expect(scheduledDigestStatus({ ...base, server: { phase: 'done' } })).toMatchObject({ pending: false, abandoned: false, delayed: false, note: expect.stringMatching(/prepared/) })
    // A held marker left on a finished digest (the run was released and completed) means nothing.
    expect(scheduledDigestStatus({ ...base, server: { phase: 'done', held: { reason: 'x' } } })).toMatchObject({ held: false, delayed: false })
  })
  it('a digest the reader ran in the browser is not a scheduled digest', () => {
    expect(scheduledDigestStatus({ ...base, runBy: 'user', server: null })).toBeNull()
    expect(scheduledDigestStatus(null)).toBeNull()
  })
  it('isHeldRun recognises a held tick and a run refused for the hold, and nothing else', () => {
    expect(isHeldRun({ ran: true, phase: 'held' })).toBe(true)
    expect(isHeldRun({ ran: false, reason: 'spending stopped: unresolved_liability' })).toBe(true)
    for (const other of [{ ran: false, reason: 'spending stopped: spending_paused' }, { ran: false, reason: 'cap reached' }, { ran: true, phase: 'capped' }, { ran: true, phase: 'error' }, { ran: false, reason: 'already running' }, null, undefined]) expect(isHeldRun(other)).toBe(false)
  })
})

describe('no continuing a held or stopped server digest', () => {
  const sched = (server, extra = {}) => scheduledDigestStatus({ kind: 'daily', runBy: 'scheduler', ranAt: '2026-10-10T10:00:00.000Z', results: [], server, ...extra })
  it('frozenDigestState: held and abandoned scheduler digests are frozen; everything else is not', () => {
    expect(frozenDigestState(sched({ phase: 'reading', held: { reason: 'unresolved_liability' } }))).toBe('held')
    expect(frozenDigestState(sched({ phase: 'rank', held: { reason: 'unresolved_liability' } }))).toBe('held')
    expect(frozenDigestState(sched({ phase: 'done', abandoned: true }))).toBe('abandoned')
    expect(frozenDigestState(sched({ phase: 'reading' }))).toBeNull() // an ordinary unfinished server run
    expect(frozenDigestState(sched({ phase: 'done' }))).toBeNull()
    expect(frozenDigestState(scheduledDigestStatus({ kind: 'daily', runBy: 'user', server: null, results: [] }))).toBeNull() // a browser-lane digest
    expect(frozenDigestState(null)).toBeNull()
  })

  it('the gate blocks while frozen, accepts only the two frozen states, and clears', () => {
    const gate = createContinuationGate()
    expect([gate.blocked(), gate.state()]).toEqual([false, null])
    gate.freeze('held'); expect([gate.blocked(), gate.state()]).toEqual([true, 'held'])
    gate.freeze('abandoned'); expect([gate.blocked(), gate.state()]).toEqual([true, 'abandoned'])
    gate.freeze('pending'); expect(gate.blocked()).toBe(false) // not a frozen state
    gate.freeze('held'); gate.freeze(null); expect(gate.blocked()).toBe(false)
    gate.freeze('held'); gate.clear(); expect([gate.blocked(), gate.state()]).toEqual([false, null])
  })

  it('an action queued before the digest was found held stops at its next step', async () => {
    // The shape of the screen's run loop: check the gate before each paid step.
    const gate = createContinuationGate()
    const sent = []
    let release
    const firstPaper = new Promise((r) => { release = r })
    const run = async (papers, wait = Promise.resolve()) => { for (const p of papers) { if (gate.blocked()) return 'stopped'; sent.push(p); await wait } return gate.blocked() ? 'stopped' : 'ranked' }
    const queued = run(['a', 'b', 'c'], firstPaper) // the first paper is being read
    gate.freeze('held') // the server's refusal arrives meanwhile
    release()
    expect(await queued).toBe('stopped')
    expect(sent).toEqual(['a']) // nothing after the refusal, and no ranking
    expect(await run(['d'])).toBe('stopped') // and nothing started afterwards
    expect(sent).toEqual(['a'])
    gate.clear()
    expect(await run(['e'])).toBe('ranked') // a deliberately started new run is not blocked
  })

  it('held: no Finish, no retry, no run control, pool locked, whatever else is true', () => {
    for (const extra of [{}, { incomplete: true }, { missing: 3 }, { failedCount: 2 }, { incomplete: true, missing: 3, failedCount: 2, busy: false }]) {
      expect(digestControlPolicy({ frozen: 'held', ...extra })).toEqual({ frozen: 'held', showFinish: false, failedCount: 0, lockedToday: true, poolLocked: true })
    }
  })

  it('abandoned: no Finish, no retry, pool locked; the separate new-run control keeps its own rule', () => {
    expect(digestControlPolicy({ frozen: 'abandoned', incomplete: true, missing: 1, failedCount: 2 })).toEqual({ frozen: 'abandoned', showFinish: false, failedCount: 0, lockedToday: false, poolLocked: true })
    expect(digestControlPolicy({ frozen: 'abandoned', missing: 1, lockedToday: true }).lockedToday).toBe(true) // today's digest on screen: unchanged rule
  })

  it('ordinary digests are unchanged: a short restore or a live gap offers Finish, failed papers offer retry', () => {
    expect(digestControlPolicy({ incomplete: true })).toEqual({ frozen: null, showFinish: true, failedCount: 0, lockedToday: false, poolLocked: false })
    expect(digestControlPolicy({ missing: 2, failedCount: 1 })).toEqual({ frozen: null, showFinish: true, failedCount: 1, lockedToday: false, poolLocked: false })
    expect(digestControlPolicy({ missing: 2, busy: true }).showFinish).toBe(false) // as before: not while a run is under way
    expect(digestControlPolicy({ incomplete: true, busy: true }).showFinish).toBe(true)
    expect(digestControlPolicy({ lockedToday: true }).lockedToday).toBe(true)
    expect(digestControlPolicy({})).toEqual({ frozen: null, showFinish: false, failedCount: 0, lockedToday: false, poolLocked: false })
    expect(digestControlPolicy({ frozen: 'pending', missing: 1 }).showFinish).toBe(true) // an ordinary unfinished server run is not frozen
  })
})
