// pipeline/seed.js — populate a new library from the reference collection.
//
// reference_papers is a hand-curated list per specialty of papers already present in the
// shared evidence cache. On a signed-in account's first run with an empty library, each one
// goes through runPaper in cacheOnly mode: the source is fetched from PMC or PubMed (free),
// the cached extraction is replayed, and the verifier proves every badge in this session.
// No model call is ever made here; a paper missing from the cache is skipped, not paid for.
//
// The seeded records carry saveSource 'seed' so the Library can label them and the study
// can tell a seeded save from a chosen one. The profile is stamped so this runs once.

import { store, getProfile, saveProfile } from '../lib/store.js'
import { supabase, supabaseConfigured, isSignedIn } from '../lib/supabase.js'
import { logEvent } from '../lib/events.js'
import { runPaper } from './pipeline.js'
import { savePaper } from './save.js'

export const SPECIALTIES = ['vascular-surgery', 'general-surgery', 'cardiology', 'general']
export const SEED_MAX = 20

// Map free text to a reference_papers specialty slug. Pure; unknown text seeds from the
// general shelf rather than guessing.
export function specialtySlug(text) {
  const t = String(text || '').toLowerCase()
  if (/vascular/.test(t)) return 'vascular-surgery'
  if (/cardio|cardiac|heart/.test(t)) return 'cardiology'
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
    if (seen.has(r.pmid)) continue
    seen.add(r.pmid)
    out.push(r)
    if (out.length >= max) break
  }
  return out
}

// Should seeding run now. Pure.
export function seedDue({ signedIn, configured, profile, paperCount }) {
  return Boolean(configured && signedIn && profile?.onboarded && !profile?.demo && !profile?.seededAt && paperCount === 0)
}

// Run seeding if due. Resolves { seeded, skipped } or null when nothing was attempted.
// Never throws; a partial run is fine because every save is independent.
export async function seedLibraryIfDue({ onProgress } = {}) {
  const profile = await getProfile()
  const papers = (await store.all('papers')) || []
  if (!seedDue({ signedIn: isSignedIn(), configured: supabaseConfigured, profile, paperCount: papers.length })) return null

  const specialty = profile.specialty || specialtySlug(profile.rubric?.criteria || profile.northStars?.join(' '))
  let rows = []
  try {
    const { data, error } = await supabase.from('reference_papers').select('specialty, pmid, rank, note')
    if (!error) rows = data || []
  } catch {
    rows = []
  }
  const picks = pickSeedRows(rows, specialty)
  // Stamp first so a reload mid-run never seeds twice; an empty shelf still counts as done.
  await saveProfile({ ...profile, specialty, seededAt: new Date().toISOString() })
  if (!picks.length) return { seeded: 0, skipped: 0 }

  let seeded = 0
  let skipped = 0
  for (const row of picks) {
    onProgress?.({ done: seeded + skipped, total: picks.length })
    try {
      const paper = { id: row.pmid, pmid: row.pmid, pmcid: null, nct: null, title: null }
      const res = await runPaper(paper, { cacheOnly: true })
      if (res.error) { skipped++; continue }
      await savePaper(res, {}, { title: res.citation?.title || `PMID ${row.pmid}`, source: 'seed', notes: row.note || '' })
      seeded++
    } catch {
      skipped++
    }
  }
  logEvent('library_seeded', { specialty, seeded, skipped })
  return { seeded, skipped }
}
