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
