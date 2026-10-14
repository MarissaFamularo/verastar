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

import { evidenceVerdict, isRelationshipValidated, VERIFICATION_VERSION } from './evidenceVersion.js'
import { verify } from '../pipeline/verify.js'
import { allowedNumbers, allowedTimepoints, allowedCiLevels, numbersGrounded } from '../pipeline/numberFree.js'
import { fmtNum } from './format.js'
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

// A saved finding was number-guarded against the verdicts of its day. When a re-derived
// verdict demotes one of those rows, the sentence would keep a digit no badge backs, as
// plain prose. Run the same guard again against the CURRENT validated rows and withhold
// the finding when it no longer passes (2026-10-14 beta audit). Pure; exported for tests.
export function regateTriaged(triaged, results) {
  if (!triaged || typeof triaged !== 'object') return triaged ?? {}
  const byId = new Map((results || []).map((r) => [String(r?.paper?.id), r]))
  const out = {}
  for (const [id, take] of Object.entries(triaged)) {
    const finding = String(take?.finding ?? '')
    const result = byId.get(String(id))
    if (!finding || !take || !result) {
      out[id] = take
      continue
    }
    const verified = (result.rows || [])
      .filter((row) => isRelationshipValidated(row.verdict))
      .map((row) => ({ name: row.quantity?.name, value: fmtNum(row.quantity || {}), quote: row.quantity?.source_quote }))
    const ok = numbersGrounded(finding, allowedNumbers(verified), allowedTimepoints(verified), allowedCiLevels(verified))
    out[id] = ok ? take : { ...take, finding: '', findingWithheld: 'stale-numbers' }
  }
  return out
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
  const processedResults = currentEvidenceView(record.processedResults ?? record.results ?? [])
  return {
    results: currentEvidenceView(record.results ?? []),
    processedResults,
    triaged: regateTriaged(record.triaged ?? {}, processedResults),
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
  const processed = Array.isArray(digest?.processedResults) ? digest.processedResults : []
  const triaged = digest?.triaged && typeof digest.triaged === 'object' ? digest.triaged : {}
  let missing = 0
  const counted = new Set()
  // A paper that was read but never ranked is a gap whether or not it is on screen: an
  // appended read (coverage fallback, add-more) stays out of `results` until ranking
  // scores it, so a failed ranking leaves it only in processedResults.
  for (const r of [...results, ...processed]) {
    const id = r?.paper?.id
    if (id == null || r?.error || r?.retracted || counted.has(String(id))) continue
    counted.add(String(id))
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

// --- scheduled digests that did not simply finish ---------------------------------------------
// HELD: a paid step of the server run ended without a confirmed outcome, so the run is paused
// until an operator has checked it (supabase/migrations/20261010130000_scheduler_hold.sql).
// Running it again cannot help and is refused, so the message must not invite a retry.
export const HELD_DIGEST_NOTE = 'Your digest is delayed. One step did not finish cleanly, so it is paused while that is checked. You do not need to do anything, and starting it again will not speed it up. Everything already read is saved.'
// ABANDONED: an operator closed an unfinished server run. What was read is kept, but this is
// not a completed digest and must not read as one.
export const ABANDONED_DIGEST_NOTE = 'This digest was stopped before it was finished. What was read is kept below, but it is not a complete digest.'
const PREPARING_DIGEST_NOTE = 'Your digest is still being prepared on the server. It keeps going if you close the app; check back in a few minutes.'

// Did the digest server refuse or stop a run because the account is held? True for a tick that
// stopped on an unresolved step (phase 'held') and for a run that was not started for that
// reason, by cron or by hand.
export function isHeldRun(out) {
  return out?.phase === 'held' || /unresolved_liability/.test(String(out?.reason ?? ''))
}

// What the restore line says about a digest the server prepared, and how to treat it.
//   pending    the server run has not finished (includes held)
//   held       it is paused on an unresolved step; do not start or continue it from here
//   abandoned  an operator stopped it; shown as stopped, never as a finished digest
// Returns null for a digest the reader ran in the browser (restoreNote covers those).
export function scheduledDigestStatus(saved) {
  if (!saved || saved.runBy !== 'scheduler') return null
  const phase = saved.server?.phase
  const shown = Array.isArray(saved.results) && saved.results.length > 0
  const phasePending = !!phase && phase !== 'done'
  // A finished read with a summary for every paper is the digest, even if a stale
  // phase never moved to 'done'. Saying it is "still being prepared" over that page
  // is the 2026-10-12 header bug. A hold still wins: the page must not look finished.
  const ready = shown && digestGaps(saved).complete && !saved.server?.held
  const pending = phasePending && !ready
  const held = phasePending && !!saved.server?.held
  const abandoned = !pending && saved.server?.abandoned === true
  const ran = saved.ranAt ? new Date(saved.ranAt) : null
  const morning = ran && !Number.isNaN(ran.getTime()) && ran.getHours() < 8
  const note = held ? HELD_DIGEST_NOTE
    : pending && shown ? 'Your papers are here. Summaries are still being finished on the server. You can close the app; they will be filled in when that finishes.'
      : pending ? PREPARING_DIGEST_NOTE
        : abandoned ? ABANDONED_DIGEST_NOTE
          : morning ? 'Your morning digest, prepared while you slept.' : 'Your digest, prepared on the server.'
  return { note, pending, held, abandoned, delayed: held || abandoned }
}

// --- no continuing a held or stopped server digest from the reader's screen ----------------------
// A held digest is paused for an operator; an abandoned one was closed by an operator. Either way
// THAT digest is not finished, retried, topped up or auto-continued from the browser: the screen
// says it is delayed or stopped, and offering "Finish" beside that would contradict it. This is
// screen consistency only. It is not a spending rule (the database hold covers scheduler attempts
// only, and browser-proxy policy is unchanged), and it says nothing about starting a NEW scan,
// which keeps its own rules.
export function frozenDigestState(status) {
  return status?.held ? 'held' : status?.abandoned ? 'abandoned' : null
}

// One gate every continuation path checks: at the button, at the handler, and between the steps
// of a run already in flight, so an action queued before the digest was found held stops too.
export function createContinuationGate() {
  let frozen = null
  return {
    freeze(state) { frozen = state === 'held' || state === 'abandoned' ? state : null },
    clear() { frozen = null },
    state: () => frozen,
    blocked: () => frozen !== null,
  }
}

// What the digest screen may offer, in one place so every control agrees.
//   frozen       'held' | 'abandoned' | null   the digest on screen
//   showFinish   the "Finish this digest" block (unranked or unread papers)
//   failedCount  how many failed papers the retry control may offer
//   lockedToday  no run control at all (today's digest is on screen, or the run is held)
//   poolLocked   the candidate pool's run / add / re-score actions
export function digestControlPolicy({ frozen = null, incomplete = false, missing = 0, failedCount = 0, busy = false, lockedToday = false } = {}) {
  const stopped = frozen === 'held' || frozen === 'abandoned'
  return {
    frozen: stopped ? frozen : null,
    showFinish: !stopped && (!!incomplete || (!busy && missing > 0)),
    failedCount: stopped ? 0 : failedCount,
    lockedToday: !!lockedToday || frozen === 'held',
    poolLocked: stopped,
  }
}

// Overwrites the single daily-digest slot. Callers fire-and-forget.
export function saveDailyDigest(state) {
  return store.put(COLLECTION, KEY, serializeDigest(state))
}

// Pure: may a write of the digest dated `incomingRanAt` replace `existing`? Not when the
// stored digest is a newer scan: the server can start today's digest while yesterday's is
// still on screen, and a heart or an open-access link landing there would otherwise write
// yesterday back over it. Records from before ranAt existed carry no scan date to compare,
// so they never block.
export function mayOverwriteDigest(existing, incomingRanAt) {
  if (!existing || existing.kind !== 'daily' || !existing.ranAt || !incomingRanAt) return true
  return new Date(existing.ranAt).getTime() <= new Date(incomingRanAt).getTime()
}

// Signed in, the database also refuses a browser write that would destroy newer digest state
// (supabase/migrations/20261010120000_digest_write_guard.sql): the read above a write and the
// write itself are two requests, and the scheduler can save in between. The refusal arrives
// as an error whose message carries `digest_stale:<rule>`. Returns the rule name, or null
// for any other error. Signed out there is no such refusal and nothing here changes.
export function staleDigestReason(err) {
  const match = /digest_stale:([a-z_]+)/.exec(String(err?.message ?? err ?? ''))
  return match ? match[1] : null
}

// The digest screen's save. Resolves true when the digest was written, and false when it
// was NOT: a newer digest has replaced the one on screen, or a scheduled run owns the
// record. The first check is local and cheap; the database makes the same decision
// atomically for the write itself. A false is a save that did not happen, so callers that
// show the change as kept must say so (SpineCheck's persistDigest does).
export async function saveDailyDigestIfCurrent(state) {
  const existing = await store.get(COLLECTION, KEY)
  if (!mayOverwriteDigest(existing, state?.ranAt)) return false
  try {
    await saveDailyDigest(state)
  } catch (err) {
    if (staleDigestReason(err)) return false
    throw err
  }
  return true
}

// Stamp the digest on screen as opened, once. Idempotent and best-effort: the stamp is
// the scheduler's signal, never something the reader can see or lose the digest over.
//
// `ranAt` names the digest that was shown: if a different scan has replaced it, nothing is
// stamped (a digest nobody saw must not read as opened). The write is the whole record read
// a moment earlier plus the stamp. If the record changed in between, the database refuses
// it rather than let it undo that change; the fresh record is then read and stamped, a few
// times at most.
export async function markDigestOpened(now = new Date().toISOString(), { ranAt = null } = {}) {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await store.get(COLLECTION, KEY)
      if (!record || record.kind !== 'daily' || record.openedAt) return false
      if (ranAt && digestRanAt(record) !== ranAt) return false
      try {
        await store.put(COLLECTION, KEY, { ...record, openedAt: now })
        return true
      } catch (err) {
        if (!staleDigestReason(err)) throw err
      }
    }
    return false
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
// Resolves true when the slot is clear, and false when the database refused because a
// scheduled run is writing the digest right now (the record is left as it is).
export async function clearDailyDigest() {
  try {
    await store.delete(COLLECTION, KEY)
    return true
  } catch (err) {
    if (staleDigestReason(err)) return false
    throw err
  }
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
