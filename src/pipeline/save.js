// pipeline/save.js — the SINGLE "persist a verified paper into the Library" path, shared by the
// digest's Save button (SpineCheck) and the "Add a paper" external entry point (AddPaper) so the two
// can never drift. Given a runPaper result + its triage take, it writes the paper record to the
// store and, in the background, files it under a concept, resolves an open-access PDF link, and
// writes it to the connected on-disk folder. The background work never blocks (or breaks) the save.

import { evidenceVerdict } from '../lib/evidenceVersion.js'
import { store } from '../lib/store.js'
import { logEvent } from '../lib/events.js'
import { filePaper, synthesizeGroup, consolidateDomains } from './deposit.js'
import { maybeReorganize } from './categorize.js'
import { resolveOaLink, oaPatch } from './openaccess.js'
import { depositPaperToLibrary } from '../lib/library.js'
import { citationIndicatesRetraction, retractionPatch } from './retractions.js'

// Build the persisted paper record from a run result + its triage take. Pure. The verified numbers
// retain every proposed row and its versioned verdict (including unresolved evidence); finding/relevance/tier come
// from the triage take (the prose channel). Mirrors the record SpineCheck.toggleSave used to inline.
export function buildPaperRecord(res, take, { title, source = 'unknown', notes = '' } = {}) {
  const evidenceRows = res.error ? [] : (res.rows || [])
  const retraction = retractionPatch(res.citation)
  return {
    id: res.paper.id,
    pmid: res.paper.pmid,
    pmcid: res.source?.pmcid || null, // proven-free PMC copy — the Library's full-text fallback
    title: title || res.paper.title || res.citation?.title || `PMID ${res.paper.pmid}`,
    citation: res.citation || null,
    design: res.design || null,
    // Comes from the run itself, not from save-time code. A restored digest extracted by
    // an older build must remain honestly old even if the clinician saves it today.
    extractionVersion: res.extractionVersion || null,
    score: take?.score != null && Number.isFinite(Number(take.score))
      ? Math.min(100, Math.max(0, Math.round(Number(take.score))))
      : null,
    tier: take?.tier ?? null,
    finding: take?.finding ?? '',
    designCaution: take?.designCaution ?? '',
    relevance: take?.relevance ?? '',
    // Prose-gate verdict for the finding ({ verdict, reason }) — 'refuted' means the
    // digest withheld this sentence; stored so Library surfaces can honor it too.
    check: take?.check ?? { verdict: 'unchecked', reason: '' },
    cautionCheck: take?.cautionCheck ?? { verdict: 'unchecked', reason: '' },
    quantities: evidenceRows.map((r) => ({ ...r.quantity, tier: evidenceVerdict(r.verdict).tier, verdict: evidenceVerdict(r.verdict) })),
    fullText: res.sourceDoc?.text || '', // untruncated — the concept summarizer + library note use it
    tables: res.sourceDoc?.tables || '',
    // Open-access link via Unpaywall (bytes are CORS-dead, so a LINK): a direct PDF fills pdfUrl,
    // a landing-page-only location fills oaUrl. Seeded from the digest card's already-resolved
    // link when present (res.oa); otherwise resolved in the background after save.
    pdfUrl: null,
    oaUrl: null,
    ...(oaPatch(res.oa) || {}),
    domain: null, // one of the 6 domain keys — filled by the background analyze (colors the node)
    tags: [],
    conceptId: null, // the concept node it's filed under
    // Her one-line "why" — captured by the skippable prompt right after save (or typed
    // later in the Library). This is the field the wiki export keeps; everything else
    // about the paper is a PubMed/Verastar lookup.
    notes: String(notes || '').trim(),
    saveSource: source,
    savedAt: new Date().toISOString(),
    ...(retraction || {}),
  }
}

// Only evidence-owned fields are replaced. Everything the clinician did after saving the paper
// stays exactly as it was, including notes, tags, favorites, concept placement, memos, savedAt —
// and fields written by other apps sharing the account (PaperTrellis provenance). Shared by the
// re-extraction flow (refreshEvidence) and by savePaper when the paper already exists.
export function mergeRefreshedEvidence(existing, fresh, refreshedAt = new Date().toISOString()) {
  return {
    ...existing,
    pmid: fresh.pmid || existing.pmid,
    pmcid: fresh.pmcid || existing.pmcid || null,
    title: fresh.title || existing.title,
    citation: fresh.citation || existing.citation || null,
    design: fresh.design ?? null,
    extractionVersion: fresh.extractionVersion || null,
    score: fresh.score ?? null,
    tier: fresh.tier ?? null,
    finding: fresh.finding || '',
    designCaution: fresh.designCaution || '',
    relevance: fresh.relevance || '',
    check: fresh.check || { verdict: 'unchecked', reason: '' },
    cautionCheck: fresh.cautionCheck || { verdict: 'unchecked', reason: '' },
    quantities: Array.isArray(fresh.quantities) ? fresh.quantities : [],
    fullText: fresh.fullText || '',
    tables: fresh.tables || '',
    pdfUrl: fresh.pdfUrl || existing.pdfUrl || null,
    oaUrl: fresh.oaUrl || existing.oaUrl || null,
    evidenceRefreshedAt: refreshedAt,
  }
}

// Persist the record, then run the background enrichment (concept filing → summary, OA PDF link,
// on-disk write). Returns the persisted record immediately; the background work is fire-and-forget.
export async function savePaper(res, take, { title, source = 'unknown', notes = '' } = {}) {
  if (res?.retracted || citationIndicatesRetraction(res?.citation)) {
    throw new Error('This article is marked as retracted in PubMed and was not saved.')
  }
  const record = buildPaperRecord(res, take, { title, source, notes })
  // A save must never silently destroy curation. If the pmid is already in the Library —
  // synced in from PaperTrellis, or saved from an older digest still on screen — treat this
  // like a refresh: fresh evidence in, everything the record accrued stays (including an
  // earlier "why"; a new note on an existing paper goes through setPaperNote).
  const existing = await store.get('papers', record.id)
  const persisted = existing ? mergeRefreshedEvidence(existing, record) : record
  await store.put('papers', record.id, persisted, { restoreDeleted: !existing })
  // Adoption telemetry on the ONE shared save path, so no entry point can forget it.
  // `source` says which doorway: the digest's checkbox/heart or the manual Add a paper.
  logEvent('paper_saved', { pmid: persisted.pmid, source })
  enrichInBackground(persisted)
  return persisted
}

// Attach (or replace) the one-line "why" on an already-saved paper. Used by the prompt
// that follows a save; the Library's note editor writes the same field. A paper that was
// un-saved in the meantime rejects the edit, never re-created. Prompt callers
// pass the snapshot from when drafting began so same-field conflicts stay visible.
export async function setPaperNote(id, notes, baseline) {
  const cur = baseline || await store.get('papers', id)
  if (!cur) throw new Error('This paper was removed. The note was not saved.')
  const next = { ...cur, notes: String(notes || '').trim() }
  await store.put('papers', id, next)
  logEvent('paper_noted', { pmid: cur.pmid, surface: 'save-prompt' })
  return next
}

// Saved recently with no "why" yet — the Today rail's nudge. Pure; `now` is injectable
// for tests. Defensive on shape: a legacy record without savedAt is not "recent".
export function savedWithoutWhy(papers, { days = 7, now = Date.now() } = {}) {
  const since = now - days * 86400000
  return (papers || []).filter((p) => {
    const t = Date.parse(p?.savedAt || '')
    return Number.isFinite(t) && t >= since && !String(p?.notes || '').trim()
  })
}

// Backfill open-access links for already-saved papers that don't have one yet (DOI present,
// pdfUrl/oaUrl still null). Covers papers saved before enrichment existed, or whose resolve missed
// at save time (network/rate-limit) — the Library gives them a second chance on load. Runs
// sequentially to stay polite to Unpaywall, never throws, and calls onPatched(id, patch) as each
// link lands so the UI can light up its badge without a reload. Idempotent: a paper that already
// has a link, has no DOI, or genuinely isn't open-access is skipped and never retried into a link
// that doesn't exist.
export async function backfillOaPdfs(papers, onPatched) {
  for (const p of papers || []) {
    if (p?.pdfUrl || p?.oaUrl || !p?.citation?.doi) continue
    try {
      const patch = oaPatch(await resolveOaLink(p.citation.doi))
      if (!patch) continue
      const cur = await store.get('papers', p.id)
      if (cur && !cur.pdfUrl && !cur.oaUrl) {
        await store.put('papers', p.id, { ...cur, ...patch })
        onPatched?.(p.id, patch)
      }
    } catch {
      /* a single miss never blocks the rest */
    }
  }
}

// File under a concept (+ re-synthesize its summary), resolve an OA PDF link, and deposit to the
// on-disk library. Each step is independently try/caught so none can undo the save above.
function enrichInBackground(record) {
  const id = record.id
  ;(async () => {
    try {
      const filed = await filePaper(record)
      if (filed?.groupId) await synthesizeGroup(filed.groupId)
    } catch (err) {
      console.warn('Concept filing failed (paper still saved):', err.message)
    }
    try {
      await consolidateDomains() // keep the field taxonomy a handful as the library grows
    } catch (err) {
      console.warn('Field tidy skipped:', err.message)
    }
    // Reorganize the category shelves only when the trigger condition says so (>10 hubs, or
    // enough shelf-less concepts). maybeReorganize never throws; a failure is a silent no-op.
    await maybeReorganize()
    try {
      const doi = record.citation?.doi
      if (doi && !record.pdfUrl && !record.oaUrl) {
        const patch = oaPatch(await resolveOaLink(doi))
        if (patch) {
          const cur = await store.get('papers', id)
          if (cur) await store.put('papers', id, { ...cur, ...patch })
        }
      }
    } catch (err) {
      console.warn('OA link resolve failed (paper still saved):', err.message)
    }
    try {
      const filed = await store.get('papers', id)
      if (filed) await depositPaperToLibrary(filed)
    } catch (err) {
      console.warn('Library deposit failed (paper still saved):', err.message)
    }
  })()
}
