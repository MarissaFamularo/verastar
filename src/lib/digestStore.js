// lib/digestStore.js — persist the daily digest across tab switches.
//
// App.jsx unmounts SpineCheck on every tab change, and re-running the digest costs real
// extraction calls — so the digest state (results, triage, candidate pool, selection) is
// mirrored to IndexedDB and rehydrated on mount.
//
// Coexistence: the record lives in the shared 'digests' collection under the fixed key
// 'daily:latest', tagged kind:'daily'. WeekendRead scans store.all('digests') but keeps
// only records with type === 'weekend' && read — this record has neither field, so it is
// invisible to that filter. Do not add a `type` field here.

import { evidenceVerdict, VERIFICATION_VERSION } from './evidenceVersion.js'
import { verify } from '../pipeline/verify.js'
import { store } from './store.js'

const COLLECTION = 'digests'
const KEY = 'daily:latest'
const LAST_SCAN_KEY = 'daily:last-successful-scan'

// State -> storable record. selectedIds is a Set in the UI; persisted as an array so the
// record stays plain data.
export function serializeDigest({ results, processedResults, triaged, candidates, preCapCandidates, searchContext, selectedIds, openedAt = null, runBy = 'user', server = null, ranAt = null } = {}) {
  const savedAt = new Date().toISOString()
  return {
    kind: 'daily',
    savedAt,
    // When the scan that produced this digest ran. savedAt moves on every write (a heart,
    // a library save, an open-access link landing); ranAt does not. Every "is this today's
    // digest" question reads ranAt — reading savedAt re-dated yesterday's digest as today's
    // the moment it was opened, which locked out the next scan (2026-09-25).
    ranAt: ranAt ?? savedAt,
    // Stamped by the app the first time this digest is shown. A scheduled run checks it:
    // a digest nobody opened is never replaced by another one nobody will open.
    openedAt: openedAt ?? null,
    runBy, // 'user' | 'scheduler'
    server, // scheduler bookkeeping ({ phase, ... }) or null
    results: results ?? [],
    processedResults: processedResults ?? results ?? [],
    triaged: triaged ?? {},
    candidates: candidates ?? [],
    preCapCandidates: preCapCandidates ?? candidates ?? [],
    searchContext: searchContext ?? { counts: [], failed: [], days: null },
    selectedIds: Array.from(selectedIds ?? []),
  }
}

// A verdict stamped by an older verifier is re-derived from the source text the digest
// saved alongside it — the exact corpus the original verdict was computed against — so a
// verifier fix reaches digests already on screen without a paid re-run. Registry rows are
// not saved, so a re-derived verdict can lose a registry upgrade but never gain one.
// Without saved source text, the read-time version policy applies as before.
function currentVerdict(result, row) {
  if (row.verdict?.verificationVersion === VERIFICATION_VERSION) return row.verdict
  const doc = result.sourceDoc
  if (row.quantity && doc && (doc.text || doc.tables)) {
    return verify(row.quantity, doc, { sourceTier: result.source?.tier || row.verdict?.sourceTier || 'abstract_only' })
  }
  return evidenceVerdict(row.verdict)
}

function currentEvidenceView(results) {
  return results.map((result) => ({ ...result, rows: result.rows?.map((row) => ({ ...row, verdict: currentVerdict(result, row) })) }))
}

// The date that says which day a digest belongs to. Records written before ranAt existed
// fall back to savedAt.
export function digestRanAt(record) {
  return record?.ranAt ?? record?.savedAt ?? null
}

// Record -> state. Returns null for anything that isn't a daily-digest record, so a
// foreign record under the key can never masquerade as a digest.
export function reviveDigest(record) {
  if (!record || record.kind !== 'daily') return null
  return {
    results: currentEvidenceView(record.results ?? []),
    processedResults: currentEvidenceView(record.processedResults ?? record.results ?? []),
    triaged: record.triaged ?? {},
    candidates: record.candidates ?? [],
    preCapCandidates: record.preCapCandidates ?? record.candidates ?? [],
    searchContext: record.searchContext ?? { counts: [], failed: [], days: null },
    selectedIds: new Set(record.selectedIds ?? []),
    savedAt: record.savedAt ?? null,
    ranAt: digestRanAt(record),
    openedAt: record.openedAt ?? null,
    runBy: record.runBy ?? 'user',
    server: record.server ?? null,
  }
}

// A run writes its snapshot from the array it collected paper-by-paper, and that array
// predates the open-access links resolved (asynchronously) alongside the run. Re-applies
// those links so a restored digest keeps its free-full-text links instead of re-resolving
// them. `resolved` is a Map of paper id -> oa object, or null for "looked, nothing free".
// A result that already carries an `oa` field is left exactly as it is.
export function withOaLinks(results, resolved) {
  if (!Array.isArray(results)) return []
  if (!resolved?.size) return results
  return results.map((r) => {
    const id = r?.paper?.id
    if (r?.oa !== undefined || id == null || !resolved.has(id)) return r
    return { ...r, oa: resolved.get(id) ?? null }
  })
}

// Is a restored digest whole? The ranking step (pipeline/triage) writes the finding and the
// relevance for every successful paper in ONE call, so a result with no entry in `triaged`
// renders as a card with no summary. Two ways that happens: the ranking call failed, or the
// snapshot was written before it ran. Papers that errored never reach triage, so they are not
// a gap; entries with no id are ignored rather than guessed at.
export function digestGaps(digest) {
  const results = Array.isArray(digest?.results) ? digest.results : []
  const triaged = digest?.triaged && typeof digest.triaged === 'object' ? digest.triaged : {}
  let missing = 0
  for (const r of results) {
    const id = r?.paper?.id
    if (id == null || r?.error) continue
    if (!Object.prototype.hasOwnProperty.call(triaged, id)) missing += 1
  }
  return { total: results.length, missing, complete: missing === 0 }
}

// The restore line, from digestGaps' count. A digest of blank cards is what a half-written
// snapshot looks like, and it reads as a broken app — so the gap is stated, in the same
// sentence, before the offer to run again.
// A gap now has a cheaper remedy than "run again": the papers already on screen were
// fetched, extracted and verified at real cost, and Finish keeps them — it only fetches
// what never ran, then ranks the whole set. So the incomplete line points there rather
// than at a fresh scan, which would pay for all of it a second time.
export function restoreNote({ missing = 0 } = {}) {
  if (!missing) return 'Restored your last digest — run again for fresh results.'
  return `Restored your last digest — ${missing} paper${missing === 1 ? ' has' : 's have'} no summary (the run didn't finish). Finish it below to keep what's already verified, or run again for a fresh scan.`
}

// The date line above the greeting. It used to be `new Date()` unconditionally, which made
// a digest restored from yesterday look like this morning's work — the header said today,
// every card was stale, and nothing on the page disagreed. So the line reports the date of
// the DIGEST ON SCREEN, and says how old it is when that isn't today.
//
// Comparison is by local calendar day, not elapsed hours: a digest run at 11pm and read at
// 7am is yesterday's, and one run at 6am and read at 11pm is still today's. A savedAt in
// the future (a phone clock running fast — the drain stamps hit this too) reads as today
// rather than as a negative age.
function localMidnight(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function digestDateLine(savedAt, now = new Date()) {
  const full = (d) =>
    d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const parsed = savedAt ? new Date(savedAt) : null
  if (!parsed || Number.isNaN(parsed.getTime())) return { text: full(now), stale: false, days: 0 }

  const days = Math.round((localMidnight(now) - localMidnight(parsed)) / 86400000)
  if (days <= 0) return { text: full(parsed), stale: false, days: 0 }

  // Age FIRST, date second. At phone width this line wraps, and "Digest from Tuesday,
  // July 28 · yesterday" broke after the separator — leaving the one word that matters
  // stranded on line two. Front-loaded, the staleness survives any wrap.
  const when = parsed.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const age = days === 1 ? "Yesterday's digest" : `${days} days old`
  return { text: `${age} · ${when}`, stale: true, days }
}

// Is the digest on screen from today (local calendar day)? A second run on the same day
// deletes `daily:latest` before it searches, and the seen ledger has already retired every
// paper the first run surfaced — so the papers she was reading are gone and the new pool is
// whatever was left over. One accidental click did exactly that on 2026-09-15. The run
// controls use this to withhold the plain "start a new scan" path while today's digest
// exists; a deliberate replace is still possible, but only behind an explicit confirm.
export function isDigestFromToday(savedAt, now = new Date()) {
  const parsed = savedAt ? new Date(savedAt) : null
  if (!parsed || Number.isNaN(parsed.getTime())) return false
  return localMidnight(now) - localMidnight(parsed) <= 0
}

// Shown only if some other entry point tries to scan while today's digest is on screen.
// There is no same-day rerun, so this says so plainly and promises nothing else.
export function sameDayNote() {
  return "Today's digest is already here. A new one will be ready tomorrow."
}

// Overwrites the single daily-digest slot. Callers fire-and-forget.
export function saveDailyDigest(state) {
  return store.put(COLLECTION, KEY, serializeDigest(state))
}

// Stamp the digest on screen as opened, once. Idempotent and best-effort: the stamp is
// the scheduler's signal, never something the reader can see or lose the digest over.
export async function markDigestOpened(now = new Date().toISOString()) {
  try {
    const record = await store.get(COLLECTION, KEY)
    if (!record || record.kind !== 'daily' || record.openedAt) return false
    await store.put(COLLECTION, KEY, { ...record, openedAt: now })
    return true
  } catch {
    return false
  }
}

// Pure: should a scheduled run replace this record? Yes when there is no digest, or the
// last one was opened, or it is empty (nothing to read), or it is a scheduler run that never
// finished (resume instead). No when a finished digest sits unopened.
export function schedulerMayRun(record) {
  if (!record || record.kind !== 'daily') return true
  if (record.openedAt) return true
  const hasPapers = Array.isArray(record.results) && record.results.length > 0
  if (!hasPapers) return true
  if (record.runBy === 'scheduler' && record.server?.phase && record.server.phase !== 'done') return true
  return false
}

// Resolves to revived state, or null when nothing (valid) is saved.
export async function loadDailyDigest() {
  const record = await store.get(COLLECTION, KEY)
  return reviveDigest(record)
}

// A fresh scan clears this first so closing mid-scan can't resurrect stale results.
export function clearDailyDigest() {
  return store.delete(COLLECTION, KEY)
}

// The coverage checkpoint is deliberately separate from `daily:latest`: a fresh scan
// deletes that transient UI snapshot before searching, and the paper loop writes partial
// snapshots while it is still running. Advancing the checkpoint on either event would
// make a failed run look like a covered interval. Call this only after search + screening
// completed and the candidate result is available to the user (including a true zero day).
export function saveSuccessfulScan({ completedAt = new Date().toISOString(), windowDays } = {}) {
  return store.put(COLLECTION, LAST_SCAN_KEY, {
    kind: 'daily-scan-checkpoint',
    completedAt,
    windowDays,
  })
}

export async function loadSuccessfulScan() {
  const record = await store.get(COLLECTION, LAST_SCAN_KEY)
  if (!record || record.kind !== 'daily-scan-checkpoint') return null
  const completedAt = new Date(record.completedAt)
  if (Number.isNaN(completedAt.getTime())) return null
  return { completedAt: record.completedAt, windowDays: record.windowDays }
}
