// pipeline/synthesisCooldown.js — library-wide model calls run only when the library
// changed and not more often than a minimum interval.
//
// Per-paper calls (extraction, connection proposals, concept summaries) stay instant:
// they are what make saving a paper feel worthwhile. The calls this file gates are the
// ones whose cost scales with the whole library and re-run on every save: field tidying
// (consolidateDomains) and shelf reorganization (maybeReorganize). Each keeps a stamp in
// the profile collection: when it last ran and a fingerprint of the library it saw.

import { store } from '../lib/store.js'

export const SYNTHESIS_KEY = 'synthesisRuns'
export const DEFAULT_MIN_INTERVAL_MS = 5 * 24 * 60 * 60 * 1000 // five days

// A cheap fingerprint of "has the library changed": count plus the newest savedAt.
export function libraryFingerprint(papers) {
  const list = Array.isArray(papers) ? papers : []
  let newest = ''
  for (const p of list) {
    const at = String(p?.savedAt || p?.evidenceRefreshedAt || '')
    if (at > newest) newest = at
  }
  return `${list.length}:${newest}`
}

// Pure decision. `last` is { at, fingerprint } or undefined.
export function shouldRunSynthesis({ last, fingerprint, now = Date.now(), minIntervalMs = DEFAULT_MIN_INTERVAL_MS }) {
  if (!last?.at) return true
  if (last.fingerprint === fingerprint) return false
  return now - new Date(last.at).getTime() >= minIntervalMs
}

async function readRuns() {
  try {
    return (await store.get('profile', SYNTHESIS_KEY)) || {}
  } catch {
    return {}
  }
}

// Gate a library-wide call by name. Returns true when the caller should proceed and
// stamps the run; false to skip. Never throws: an unreadable stamp means "run".
export async function synthesisDue(name, { papers, minIntervalMs = DEFAULT_MIN_INTERVAL_MS, now = Date.now() } = {}) {
  const list = papers || (await store.all('papers')) || []
  const fingerprint = libraryFingerprint(list)
  const runs = await readRuns()
  if (!shouldRunSynthesis({ last: runs[name], fingerprint, now, minIntervalMs })) return false
  try {
    await store.put('profile', SYNTHESIS_KEY, { ...runs, [name]: { at: new Date(now).toISOString(), fingerprint } })
  } catch {
    /* a failed stamp costs one extra run, never a missed one */
  }
  return true
}
