// pipeline/save.js — the SINGLE "persist a verified paper into the Library" path, shared by the
// digest's Save button (SpineCheck) and the "Add a paper" external entry point (AddPaper) so the two
// can never drift. Given a runPaper result + its triage take, it writes the paper record to the
// store and, in the background, files it under a concept, resolves an open-access PDF link, and
// writes it to the connected on-disk folder. The background work never blocks (or breaks) the save.

import { store } from '../lib/store.js'
import { filePaper, synthesizeGroup } from './deposit.js'
import { resolveOaPdf } from './openaccess.js'
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
    pdfUrl: null, // resolved to an open-access LINK via Unpaywall in the background (bytes are CORS-dead)
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
      const doi = record.citation?.doi
      if (doi) {
        const oaPdf = await resolveOaPdf(doi)
        if (oaPdf) {
          const cur = await store.get('papers', id)
          if (cur) await store.put('papers', id, { ...cur, pdfUrl: oaPdf })
        }
      }
    } catch (err) {
      console.warn('OA PDF resolve failed (paper still saved):', err.message)
    }
    try {
      const filed = await store.get('papers', id)
      if (filed) await depositPaperToLibrary(filed)
    } catch (err) {
      console.warn('Library deposit failed (paper still saved):', err.message)
    }
  })()
}
