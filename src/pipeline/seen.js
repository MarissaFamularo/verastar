// pipeline/seen.js — cross-day memory for the selection funnel.
//
// Without this the digest has no memory: PubMed's newest-40 barely moves overnight, so
// the same papers resurface every morning and "what's new" quietly means "what's recent".
// The ledger is the answer to "papers I've never seen before" — a flat map of pmid ->
// the ISO date it was first shown, consulted BEFORE the scoring call so a paper we'd
// discard never costs a token.
//
// Two rules the callers depend on:
//   - a paper is stamped only after a digest run COMPLETES. An orphan stamp is the one
//     unrecoverable failure here: the paper is silently never shown again. Re-showing one
//     is a duplicate she skips in two seconds; losing one is a paper she never reads.
//   - the stamp is FIRST-seen, never refreshed. It is what eviction sorts on, so it has
//     to mean "how long ago did this enter the ledger", not "when did we last touch it".
//
// Everything here is pure and total: a missing, half-written, or hand-corrupted ledger
// normalizes to empty rather than throwing. The failure mode of a lost ledger is a day
// of repeats; the failure mode of a throw here is no digest at all.

// Ledger entries are tiny (a pmid and a date), so the cap is about bounding an
// ever-growing store record, not about relevance — 5000 covers years of daily runs and
// far outlives the 90-day search window that could resurface anything.
export const LEDGER_CAP = 5000

export const EMPTY_LEDGER = { ids: {}, updatedAt: null }

// A candidate's pmid. Search stubs carry `id` and `pmid` as the same value; library
// records only carry `id` (their store key IS the pmid), so accept either.
export function candidateId(candidate) {
  const raw = candidate?.pmid ?? candidate?.id ?? candidate
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
}

// Anything -> a usable ledger. A malformed ENTRY keeps its id with an empty stamp rather
// than being dropped: the id is the load-bearing half (it's what dedups), and an empty
// stamp sorts oldest, so a damaged entry is simply first in line for eviction.
export function normalizeLedger(raw) {
  const ids = raw?.ids
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return { ...EMPTY_LEDGER, ids: {} }
  const clean = {}
  for (const [key, stamp] of Object.entries(ids)) {
    const id = String(key)
    if (!id) continue
    clean[id] = typeof stamp === 'string' ? stamp : ''
  }
  return { ids: clean, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null }
}

// The seen pmids as a Set, ready for filterUnseen.
export function seenIds(ledger) {
  return new Set(Object.keys(normalizeLedger(ledger).ids))
}

// Candidates she has genuinely never been offered: not in the ledger, and not already
// sitting in her library (a paper she saved is one she has plainly seen — re-serving it
// is the same insult as a repeat, and the library predates the ledger).
export function filterUnseen(candidates, seen, library) {
  const skip = asIdSet(seen)
  for (const id of asIdSet(library)) skip.add(id)
  return (candidates || []).filter((c) => {
    const id = candidateId(c)
    return id !== '' && !skip.has(id)
  })
}

// Stamp pmids as shown. Idempotent: an id already in the ledger keeps its original
// (first-seen) date, so re-stamping the same pool never resets its place in the
// eviction order.
export function mergeSeen(ledger, pmids, nowIso) {
  const base = normalizeLedger(ledger)
  const ids = { ...base.ids }
  const stamp = typeof nowIso === 'string' && nowIso ? nowIso : ''
  for (const pmid of pmids || []) {
    const id = candidateId(pmid)
    if (!id || id in ids) continue
    ids[id] = stamp
  }
  return { ids, updatedAt: stamp || base.updatedAt }
}

// What a finished run has actually earned the right to stamp. `outcomes` is one entry per
// paper the pipeline ran, `{ id, error }`.
//
// A paper that ERRORED is never stamped. runPaper reports failure by returning `{ error }`
// rather than throwing, so without this a network wobble mid-run would bury exactly the
// papers it broke — she'd see a digest of error cards and never be offered those papers
// again. The rest of the pool still counts: papers that ran clean, and papers she was
// offered in the funnel and passed on (below the floor, or left unchecked) are papers she
// saw. And a run where NOTHING succeeded is not a digest she was shown at all — it stamps
// nothing, not even the untouched remainder of the pool.
export function stampableIds(pool, outcomes) {
  const ran = outcomes || []
  if (!ran.some((o) => !o?.error)) return []
  const failed = new Set(ran.filter((o) => o?.error).map((o) => candidateId(o)))
  const out = []
  for (const candidate of pool || []) {
    const id = candidateId(candidate)
    if (id && !failed.has(id)) out.push(id)
  }
  return out
}

// Keep the newest `max` entries by stamp. Ties break on pmid so eviction is
// deterministic — a whole day's pool shares one stamp, and a ledger that reorders
// itself between runs would evict different papers on every read.
export function capLedger(ledger, max = LEDGER_CAP) {
  const base = normalizeLedger(ledger)
  const limit = Number.isFinite(max) && max >= 0 ? Math.floor(max) : LEDGER_CAP
  const entries = Object.entries(base.ids)
  if (entries.length <= limit) return base
  entries.sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? 1 : -1) : a[1] < b[1] ? 1 : -1))
  return { ids: Object.fromEntries(entries.slice(0, limit)), updatedAt: base.updatedAt }
}

// Sets, arrays, and objects-of-records all show up at the call site (a Set of saved ids,
// an array of library records). Normalize them all to a Set of pmid strings.
function asIdSet(source) {
  const out = new Set()
  if (!source) return out
  for (const item of source) {
    const id = candidateId(item)
    if (id) out.add(id)
  }
  return out
}
