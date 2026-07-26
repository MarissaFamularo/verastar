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

import { store } from './store.js'

const COLLECTION = 'digests'
const KEY = 'daily:latest'

// State -> storable record. selectedIds is a Set in the UI; persisted as an array so the
// record stays plain data.
export function serializeDigest({ results, triaged, candidates, selectedIds } = {}) {
  return {
    kind: 'daily',
    savedAt: new Date().toISOString(),
    results: results ?? [],
    triaged: triaged ?? {},
    candidates: candidates ?? [],
    selectedIds: Array.from(selectedIds ?? []),
  }
}

// Record -> state. Returns null for anything that isn't a daily-digest record, so a
// foreign record under the key can never masquerade as a digest.
export function reviveDigest(record) {
  if (!record || record.kind !== 'daily') return null
  return {
    results: record.results ?? [],
    triaged: record.triaged ?? {},
    candidates: record.candidates ?? [],
    selectedIds: new Set(record.selectedIds ?? []),
    savedAt: record.savedAt ?? null,
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
export function restoreNote({ missing = 0 } = {}) {
  if (!missing) return 'Restored your last digest — run again for fresh results.'
  return `Restored your last digest — ${missing} paper${missing === 1 ? ' has' : 's have'} no summary (the ranking step didn't finish). Run again for fresh results.`
}

// Overwrites the single daily-digest slot. Callers fire-and-forget.
export function saveDailyDigest(state) {
  return store.put(COLLECTION, KEY, serializeDigest(state))
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
