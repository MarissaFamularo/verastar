// pipeline/save.js — the SINGLE "persist a verified paper into the Library" path, shared by the
// digest's Save button (SpineCheck) and the "Add a paper" external entry point (AddPaper) so the two
// can never drift. Given a runPaper result + its triage take, it writes the paper record to the
// store and, in the background, files it under a concept, resolves an open-access PDF link, and
// writes it to the connected on-disk folder. The background work never blocks (or breaks) the save.

import { store } from '../lib/store.js'
import { filePaper, synthesizeGroup, consolidateDomains } from './deposit.js'
import { resolveOaLink, oaPatch } from './openaccess.js'
import { depositPaperToLibrary } from '../lib/library.js'

// Build the persisted paper record from a run result + its triage take. Pure. The verified numbers
// are taken from the run's non-flagged rows (the app-owned channel); finding/relevance/tier come
// from the triage take (the prose channel). Mirrors the record SpineCheck.toggleSave used to inline.
export function buildPaperRecord(res, take, { title } = {}) {
  const verifiedRows = res.error ? [] : res.rows.filter((r) => !r.verdict.flagged)
  return {
    id: res.paper.id,
    pmid: res.paper.pmid,
    title: title || res.paper.title || res.citation?.title || `PMID ${res.paper.pmid}`,
    citation: res.citation || null,
    tier: take?.tier ?? null,
    finding: take?.finding ?? '',
    relevance: take?.relevance ?? '',
    quantities: verifiedRows.map((r) => ({ ...r.quantity, tier: r.verdict.tier })),
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
    notes: '',
    savedAt: new Date().toISOString(),
  }
}

// Persist the record, then run the background enrichment (concept filing → summary, OA PDF link,
// on-disk write). Returns the persisted record immediately; the background work is fire-and-forget.
export async function savePaper(res, take, { title } = {}) {
  const record = buildPaperRecord(res, take, { title })
  await store.put('papers', record.id, record)
  enrichInBackground(record)
  return record
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
