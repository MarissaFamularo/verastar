// lib/trellis.js — read-only bridge to PaperTrellis projects.
//
// PaperTrellis shares this Supabase project and auth.uid(), so the signed-in client can
// SELECT the user's `projects`/`stages` rows directly — RLS on those tables already
// scopes what she may see, and this module NEVER writes to them. The product rule:
// only PRE-SUBMISSION projects (joined stage position < 7) feed the digest's context,
// merged after the manual "Active Work" strings. Sync failure must never break a digest
// run, so refresh caches into the store and every reader falls back to that cache;
// signed out, everything here is a no-op and the digest sees exactly the manual list.

import { supabase, supabaseConfigured, isSignedIn } from './supabase.js'
import { store } from './store.js'

// Where "edit them there" actually is — the UI links synced projects back here.
export const PAPERTRELLIS_URL = 'https://papertrellis.com'

// Stage positions in PaperTrellis: Idea=1 … Submission=7, Revision=8, Published=9.
// At or past Submission the search-for-citations phase is over.
export const SUBMISSION_POSITION = 7

// Cache row in the profile collection (arbitrary keys are fine there; 'me' is the
// profile singleton and stays untouched). Shape: { projects, syncedAt }.
const CACHE_KEY = 'trellisProjects'

// Description tail for the prompt line. Prompts don't need the whole abstract-length
// description — cut near 140 chars, on a word boundary when one is close enough.
const DESC_MAX = 140

function truncateDescription(text) {
  if (text.length <= DESC_MAX) return text
  const cut = text.slice(0, DESC_MAX)
  const space = cut.lastIndexOf(' ')
  return (space > DESC_MAX / 2 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

// One prompt-ready string per project — this is what the scorer and triage prompt see,
// alongside the manual Active Work strings, so it has to read like one of those:
// title, stage in parens, optional due date, optional trimmed description.
// e.g. `Pop Artery Aneurysm (COSMOS) (Writing), due 2026-08-01 — Does anticoagulation…`
export function trellisProjectLine(p) {
  let line = `${p.title} (${p.stage?.name ?? 'Unknown stage'})`
  // deadline_at is a date column; slice guards against a timestamp sneaking through.
  if (p.deadline_at) line += `, due ${String(p.deadline_at).slice(0, 10)}`
  const desc = (p.description || '').trim()
  if (desc) line += ` — ${truncateDescription(desc)}`
  return line
}

// The digest's slice of a raw projects query: pre-submission only, rows without a
// joined stage dropped (a dangling stage fk is not a project we can place), sorted
// closest-to-submission FIRST — those are the most active, and prompt order is
// attention order. Ties break on recency of touch.
export function preSubmission(projects) {
  return (projects ?? [])
    .filter((p) => p?.stage && p.stage.position < SUBMISSION_POSITION)
    .sort(
      (a, b) =>
        b.stage.position - a.stage.position ||
        String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')),
    )
}

// Pull the current pre-submission set and cache it. PostgREST can't filter parent rows
// by an embedded column, so the stage cut happens client-side. On ANY failure — offline,
// RLS surprise, paused project — warn and hand back the existing cache: a stale project
// list is a fine digest input, a thrown sync error mid-run is not.
export async function refreshTrellisProjects() {
  if (!supabaseConfigured || !isSignedIn()) return null
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('id,title,description,deadline_at,updated_at,stage:current_stage_id(name,position)')
      .is('deleted_at', null)
    if (error) throw new Error(error.message)
    const cache = { projects: preSubmission(data), syncedAt: new Date().toISOString() }
    await store.put('profile', CACHE_KEY, cache)
    return cache
  } catch (err) {
    console.warn('PaperTrellis sync failed — using the cached projects:', err?.message || err)
    return getTrellisProjects()
  }
}

// Read the cached sync result. Absent (never synced, or signed out) resolves to the
// empty shape so callers never branch on undefined.
export async function getTrellisProjects() {
  try {
    const cache = await store.get('profile', CACHE_KEY)
    return cache ?? { projects: [], syncedAt: null }
  } catch {
    return { projects: [], syncedAt: null }
  }
}

// Cache → prompt lines.
export function trellisProjectLines(cache) {
  return (cache?.projects ?? []).map(trellisProjectLine)
}

// --- the star: which synced projects the digest may consider ---

// Not every project deserves a slot in the scorer's attention. The star lives in
// VERASTAR (this key), never in PaperTrellis — "steer my digest" is a digest
// preference, and teammates who share a project must not see it. What we store is
// the EXCLUSION list (un-starred ids): a new PaperTrellis project therefore arrives
// starred, so nothing is ever silently dropped — she prunes noise, not rescues signal.
const EXCLUDED_KEY = 'trellisExcluded'

export async function getTrellisExcluded() {
  try {
    const row = await store.get('profile', EXCLUDED_KEY)
    return new Set(row?.ids ?? [])
  } catch {
    return new Set()
  }
}

export async function setTrellisExcluded(ids) {
  await store.put('profile', EXCLUDED_KEY, { ids: [...ids] })
}

// The starred slice of a cache — what the rail shows and the digest sees.
export function consideredProjects(cache, excluded) {
  const out = new Set(excluded ?? [])
  return (cache?.projects ?? []).filter((p) => !out.has(p.id))
}

// The merge the digest call sites feed to select/triage: manual Active Work strings
// first (hers, verbatim), then only the STARRED synced lines. Pure so the shape is
// testable without mocking the store.
export function mergedProjects(profile, cache, excluded) {
  const lines = consideredProjects(cache, excluded).map(trellisProjectLine)
  return [...(profile?.projects ?? []), ...lines]
}

// What the digest call sites actually await. Signed out (or never synced) the cache is
// empty and this returns exactly `profile?.projects ?? []` — the old behavior.
export async function digestProjects(profile) {
  const [cache, excluded] = await Promise.all([getTrellisProjects(), getTrellisExcluded()])
  return mergedProjects(profile, cache, excluded)
}
