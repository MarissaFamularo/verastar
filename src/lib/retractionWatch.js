// lib/retractionWatch.js — the ONE place the saved Library is re-checked against PubMed for
// retractions, shared by app boot, every digest scan, and the Library page.
//
// Cost model: zero model tokens. One PubMed esummary call per 100 saved PMIDs, read for the
// "Retracted Publication" publication type (pipeline/retractions.js). A throttle keeps the
// three call sites from tripling that within one sitting; a digest scan or the Library can
// still force a fresh check.
//
// State lives on the saved record (`retracted`, `retraction.acknowledgedAt`), never here —
// this module only fans the current pending list out to whichever surfaces are mounted, so
// an alert found by the digest tab shows on the Library tab and vice versa.

import { store } from './store.js'
import { logEvent } from './events.js'
import { drainVault } from './library.js'
import { fetchCitations } from '../pipeline/sources.js'
import {
  acknowledgeRetractionPatch,
  pendingRetractionAlerts,
  refreshSavedRetractions,
} from '../pipeline/retractions.js'

export const MIN_CHECK_INTERVAL_MS = 10 * 60 * 1000

let _lastRunAt = 0
let _inflight = null
const _listeners = new Set()

function notify(pending, patched = []) {
  for (const fn of _listeners) {
    try {
      fn({ pending, patched })
    } catch {
      // A surface's listener must never break the check for the others.
    }
  }
}

// Subscribe to pending-alert updates. Returns the unsubscribe function.
export function subscribeRetractionAlerts(fn) {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

// Re-read the store (no network) and broadcast what is still unacknowledged.
export async function loadPendingRetractions() {
  const papers = (await store.all('papers')) || []
  const pending = pendingRetractionAlerts(papers)
  notify(pending)
  return pending
}

// Re-check every saved PMID against PubMed. `maxAgeMs` is how stale the last check may be
// before PubMed is asked again (`force` = always ask); a throttled call still re-broadcasts
// the stored pending list so a freshly mounted surface sees an alert found minutes ago.
export async function checkSavedRetractions({
  reason = 'manual',
  force = false,
  maxAgeMs = MIN_CHECK_INTERVAL_MS,
  now = () => new Date().toISOString(),
} = {}) {
  if (_inflight) return _inflight
  const freshEnough = _lastRunAt > 0 && Date.now() - _lastRunAt < (force ? 0 : maxAgeMs)
  if (freshEnough) {
    const pending = await loadPendingRetractions()
    return { pending, patched: [], skipped: true }
  }
  _inflight = (async () => {
    const papers = (await store.all('papers')) || []
    const byId = new Map(papers.map((paper) => [paper.id, paper]))
    const patched = []
    const found = await refreshSavedRetractions(papers, {
      fetchCurrent: fetchCitations,
      persist: (id, record) => store.put('papers', id, record),
      onPatch: (id, patch) => {
        const record = { ...(byId.get(id) || { id }), ...patch }
        byId.set(id, record)
        patched.push({ id, record, patch })
      },
      now,
    })
    _lastRunAt = Date.now()
    for (const { id } of found) {
      const record = byId.get(id)
      logEvent('retraction_detected', { pmid: record?.pmid || id, reason })
    }
    const pending = pendingRetractionAlerts([...byId.values()])
    notify(pending, patched)
    // The vault note re-writes itself: a retraction stamp makes the record stale to the drain
    // (lib/drain.js), so the folder copy carries the warning too. Quiet no-op without a folder.
    if (found.length) drainVault().catch(() => {})
    return { pending, patched, skipped: false }
  })()
  try {
    return await _inflight
  } finally {
    _inflight = null
  }
}

// "Keep with warning" — persist the acknowledgement and broadcast the shrunken list.
// Returns the updated record, or null when the paper is not in the Library.
export async function acknowledgeRetraction(paperId, now = new Date().toISOString()) {
  const current = await store.get('papers', paperId)
  if (!current) return null
  const next = { ...current, ...acknowledgeRetractionPatch(current, now) }
  await store.put('papers', paperId, next)
  await loadPendingRetractions()
  return next
}

// After a Library deletion the record is gone; re-broadcast so other surfaces drop the alert.
export function noteRetractionRemoved() {
  return loadPendingRetractions().catch(() => [])
}

// Test seam: forget the throttle and listeners between cases.
export function __resetRetractionWatch() {
  _lastRunAt = 0
  _inflight = null
  _listeners.clear()
}
