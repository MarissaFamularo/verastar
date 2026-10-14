// pipeline/seed.js — populate a new library from the reference collection.
//
// reference_papers is a hand-curated list per specialty of papers already present in the
// shared evidence cache. On a signed-in account's first run with an empty library, each one
// goes through runPaper in cacheOnly mode: the source is fetched from PMC or PubMed (free),
// the cached extraction is replayed, and the verifier proves every badge in this session.
// No model call is ever made here; a paper missing from the cache is skipped, not paid for,
// and the save skips the model-backed background enrichment (concept filing, summaries).
//
// The seeded records carry saveSource 'seed' so the Library can label them and the study
// can tell a seeded save from a chosen one.
//
// Resumable and idempotent (2026-10-09, revised after review).
//
// Bookkeeping lives in its OWN record, profile/starterSeed — a separate account KV row — so
// it never rewrites the editable steering profile ('me'), which seeding only reads:
//   { startedAt, specialty, lastAttemptAt, nextAttemptAt, attempts, incompleteRuns,
//     done: [pmid], removed: [pmid], failures: {pmid: n}, completedAt }
//
// Completion: only when every picked paper is saved, already in the library, or was removed
// by the reader. A failed reference query, an empty shelf, a cache miss or a fetch failure
// is RETRYABLE, never completion: the run stays open and the next attempt waits an
// exponential backoff (6 h doubling, capped at 3 days). That is a cooldown, not a timer:
// seeding is attempted when the app boots or finishes setup, so a waiting account retries
// at its next app open after the cooldown.
//
// Exclusion: within one browser, runs are serialized by the Web Locks API (cross-tab, same
// origin) and an in-module promise. Across devices — or a browser without Web Locks — there
// is NO exclusion; correctness rests on idempotent writes instead: a seeded save is
// create-only (savePaper ifAbsent; the cloud create is a row-locked compare-and-set that
// rejects an existing paper), a removed paper is never restored, and the bookkeeping is
// monotone (re-read and folded right before each write), so a lost bookkeeping update only
// costs a re-check that finds the paper present. Server-side exclusion would need a backend
// claim RPC; it is not required for correctness.

import { store, getProfile } from '../lib/store.js'
import { supabase, supabaseConfigured, isSignedIn, currentUser } from '../lib/supabase.js'
import { logEvent } from '../lib/events.js'
import { runPaper } from './pipeline.js'
import { savePaper } from './save.js'

export const SPECIALTIES = ['vascular-surgery', 'general-surgery', 'cardiology', 'general']
export const SEED_MAX = 20
// The seed record's key in the profile collection (its own KV row, never the 'me' profile).
export const SEED_STATE_KEY = 'starterSeed'
// Backoff after an incomplete run: 6 h, doubling per consecutive incomplete run, capped.
export const SEED_RETRY_MS = 6 * 60 * 60 * 1000
export const SEED_RETRY_MAX_MS = 3 * 24 * 60 * 60 * 1000

// Map free text to a reference_papers specialty slug. Pure; unknown text seeds from the
// general shelf rather than guessing.
export function specialtySlug(text) {
  const t = String(text || '').toLowerCase()
  if (/cardio|cardiac|heart/.test(t)) return 'cardiology'
  if (/\bvascular\b/.test(t)) return 'vascular-surgery'
  if (/general surg|surgeon|surgery|surgical/.test(t)) return 'general-surgery'
  return 'general'
}

// Which rows to seed for a profile: the specialty shelf first by rank, then the general
// shelf, capped. Pure.
export function pickSeedRows(rows, specialty, max = SEED_MAX) {
  const list = Array.isArray(rows) ? rows : []
  const own = list.filter((r) => r.specialty === specialty).sort((a, b) => (a.rank ?? 100) - (b.rank ?? 100))
  const general = specialty === 'general' ? [] : list.filter((r) => r.specialty === 'general').sort((a, b) => (a.rank ?? 100) - (b.rank ?? 100))
  const seen = new Set()
  const out = []
  for (const r of [...own, ...general]) {
    const pmid = String(r?.pmid || '')
    if (!pmid || seen.has(pmid)) continue
    seen.add(pmid)
    out.push({ ...r, pmid })
    if (out.length >= max) break
  }
  return out
}

// Should seeding run now. Pure.
//
// A run that has started (its record exists) keeps going until it completes, even once the
// library has papers (they are the seeded ones, or the reader's own, which are left alone).
// A library that never started only qualifies while it is empty — including an account the
// old one-shot seeder stamped `seededAt` on an empty shelf (that stamp is ignored), which is
// how those recover.
export function seedDue({ signedIn, configured, profile, seed, paperCount, now = Date.now() }) {
  if (!(configured && signedIn && profile?.onboarded && !profile?.demo)) return false
  if (seed?.completedAt) return false
  if (!seed?.startedAt && paperCount > 0) return false
  const next = Date.parse(seed?.nextAttemptAt || '')
  return !(Number.isFinite(next) && next > now)
}

// Backoff before the next attempt after `incompleteRuns` consecutive unfinished runs. Pure.
export function retryDelayMs(incompleteRuns) {
  const n = Math.max(1, Number(incompleteRuns) || 1)
  return Math.min(SEED_RETRY_MAX_MS, SEED_RETRY_MS * 2 ** (n - 1))
}

// The picks this run still has to load. Pure.
export function pendingPicks(picks, seed, libraryIds) {
  const settled = new Set([...(seed?.done || []), ...(seed?.removed || [])].map(String))
  const have = libraryIds instanceof Set ? libraryIds : new Set(libraryIds || [])
  return (picks || []).filter((r) => !settled.has(r.pmid) && !have.has(r.pmid))
}

// Fold one run's outcomes into the seed record. Pure and monotone: done/removed only grow,
// and a later success clears an earlier failure count.
//   queryOk   the reference query succeeded
//   picks     this run's planned rows
//   outcomes  { [pmid]: 'saved' | 'present' | 'removed' | 'failed' }
export function nextSeedState(seed, { queryOk, picks, outcomes = {}, now = Date.now() }) {
  const done = new Set((seed?.done || []).map(String))
  const removed = new Set((seed?.removed || []).map(String))
  const failures = { ...(seed?.failures || {}) }
  for (const [pmid, outcome] of Object.entries(outcomes)) {
    if (outcome === 'failed') {
      if (!done.has(pmid) && !removed.has(pmid)) failures[pmid] = (failures[pmid] || 0) + 1
    } else {
      ;(outcome === 'removed' ? removed : done).add(pmid)
      delete failures[pmid]
    }
  }
  const list = picks || []
  const complete = Boolean(seed?.completedAt) || Boolean(queryOk && list.length > 0 && list.every((r) => done.has(r.pmid) || removed.has(r.pmid)))
  const at = new Date(now).toISOString()
  const incompleteRuns = complete ? 0 : (seed?.incompleteRuns || 0) + 1
  return {
    ...(seed || {}),
    startedAt: seed?.startedAt || at,
    lastAttemptAt: at,
    attempts: (seed?.attempts || 0) + 1,
    incompleteRuns,
    done: [...done],
    removed: [...removed],
    failures,
    nextAttemptAt: complete ? null : new Date(now + retryDelayMs(incompleteRuns)).toISOString(),
    completedAt: seed?.completedAt || (complete ? at : null),
  }
}

async function fetchReferenceRows() {
  const { data, error } = await supabase.from('reference_papers').select('specialty, pmid, rank, note')
  if (error) throw new Error(error.message || 'reference query failed')
  return data || []
}

function browserLocks() {
  try {
    return globalThis.navigator?.locks?.request ? globalThis.navigator.locks : null
  } catch {
    return null
  }
}

function defaultDeps() {
  return {
    configured: supabaseConfigured,
    signedIn: isSignedIn(),
    lockName: `verastar-starter-seed:${currentUser()?.id || 'anon'}`,
    locks: browserLocks(),
    getProfile,
    getSeedState: () => store.get('profile', SEED_STATE_KEY),
    putSeedState: (value) => store.put('profile', SEED_STATE_KEY, value),
    listPapers: () => store.all('papers'),
    getPaper: (id) => store.get('papers', id),
    fetchReferenceRows,
    runPaper,
    savePaper,
    logEvent,
    now: () => Date.now(),
  }
}

// Re-read the record and apply `fold` to the freshest copy right before writing, so a
// concurrent runner's progress is kept rather than replaced (see Exclusion above).
async function writeSeedState(deps, fold) {
  const next = fold((await deps.getSeedState()) || null)
  await deps.putSeedState(next)
  return next
}

const REMOVED = /removed from the Library/i

let _inflight = null

// Run seeding if due. Resolves { seeded, skipped, complete } or null when nothing was
// attempted (not due, or another tab holds the lock). Never throws. Concurrent calls in
// this module share the one in-flight run; other tabs are excluded by a Web Lock.
export function seedLibraryIfDue({ onProgress, deps } = {}) {
  if (_inflight) return _inflight
  const d = { ...defaultDeps(), ...(deps || {}) }
  const run = () => runSeed({ onProgress, deps: d })
  const locked = d.locks
    ? d.locks.request(d.lockName, { ifAvailable: true }, (lock) => (lock ? run() : null))
    : run()
  _inflight = Promise.resolve(locked)
    .catch((err) => {
      console.warn('Starter seeding skipped:', err?.message || err)
      return null
    })
    .finally(() => { _inflight = null })
  return _inflight
}

async function runSeed({ onProgress, deps }) {
  const profile = await deps.getProfile()
  const seed = (await deps.getSeedState()) || null
  const papers = (await deps.listPapers()) || []
  const now = deps.now()
  if (!seedDue({ signedIn: deps.signedIn, configured: deps.configured, profile, seed, paperCount: papers.length, now })) return null

  const specialty = seed?.specialty || profile.specialty || specialtySlug(profile.rubric?.criteria || profile.northStars?.join(' '))
  // Mark the run started before any paper is saved, so an interrupted first run resumes
  // instead of looking like a library the reader filled herself.
  await writeSeedState(deps, (cur) => ({ ...(cur || {}), specialty: cur?.specialty || specialty, startedAt: cur?.startedAt || new Date(now).toISOString() }))

  let rows = []
  let queryOk = true
  try {
    rows = await deps.fetchReferenceRows()
  } catch {
    queryOk = false
  }
  const picks = pickSeedRows(rows, specialty)
  const libraryIds = new Set(papers.map((p) => String(p?.id ?? p?.pmid ?? '')))
  const todo = pendingPicks(picks, seed, libraryIds)
  const outcomes = {}
  // Already in the library: the reader's own copy or a seeded save from before a reload.
  for (const r of picks) if (libraryIds.has(r.pmid)) outcomes[r.pmid] = 'present'

  let seeded = 0
  let skipped = 0
  for (const row of todo) {
    onProgress?.({ done: seeded + skipped, total: todo.length })
    try {
      const paper = { id: row.pmid, pmid: row.pmid, pmcid: null, nct: null, title: null }
      const res = await deps.runPaper(paper, { cacheOnly: true })
      if (res?.error) { outcomes[row.pmid] = 'failed'; skipped++; continue }
      const saved = await deps.savePaper(res, {}, {
        title: res.citation?.title || `PMID ${row.pmid}`,
        source: 'seed',
        notes: row.note || '',
        modelEnrichment: false,
        restoreDeleted: false,
        ifAbsent: true, // never merge onto (and so rewrite) a paper someone else saved meanwhile
      })
      if (saved) { outcomes[row.pmid] = 'saved'; seeded++ } else outcomes[row.pmid] = 'present'
    } catch (err) {
      // A create that lost a race to another writer is a conflict, and the paper is there.
      if (REMOVED.test(String(err?.message || ''))) outcomes[row.pmid] = 'removed'
      else if (await deps.getPaper(row.pmid).catch(() => null)) outcomes[row.pmid] = 'present'
      else outcomes[row.pmid] = 'failed'
      if (outcomes[row.pmid] !== 'present') skipped++
    }
  }

  const next = await writeSeedState(deps, (cur) => nextSeedState({ ...(cur || {}), specialty }, { queryOk, picks, outcomes, now: deps.now() }))
  const complete = Boolean(next.completedAt)
  deps.logEvent('library_seeded', { specialty, seeded, skipped, picks: picks.length, queryOk, complete, attempt: next.attempts })
  return { seeded, skipped, complete }
}
