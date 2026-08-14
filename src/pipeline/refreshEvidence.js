// Refresh one incomplete saved paper through the same fetch -> extract -> deterministic verify ->
// triage path as a manual add. This is deliberately user-triggered and atomic at the Library
// record: paid work can fail, but the existing notes/tags/favorite/concept and old evidence remain
// untouched until a complete replacement snapshot is ready.

import { getProfile, store } from '../lib/store.js'
import { logEvent } from '../lib/events.js'
import { fmtNum } from '../lib/format.js'
import { extractionVersionStatus } from '../lib/evidenceVersion.js'
import { depositPaperToLibrary } from '../lib/library.js'
import { runPaper } from './pipeline.js'
import { triage } from './triage.js'
import { buildPaperRecord } from './save.js'
import { paperIndicatesRetraction } from './retractions.js'

export function needsDigestDetails(paper) {
  if (!paper?.pmid || paperIndicatesRetraction(paper)) return false
  const hasSummary = !!String(paper.finding || '').trim()
  const hasValues = Array.isArray(paper.quantities) && paper.quantities.length > 0
  const incompleteLegacyEvidence = extractionVersionStatus(paper) !== 'current' && !hasValues
  return !hasSummary || incompleteLegacyEvidence
}

// Only evidence-owned fields are replaced. Everything the clinician did after saving the paper
// stays exactly as it was, including notes, tags, favorites, concept placement, memos, and savedAt.
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

function candidateFromResult(res, id) {
  return {
    id,
    title: res.paper.title || res.citation?.title || `PMID ${id}`,
    design: res.design,
    summary: res.sourceDoc?.text || '',
    verified: res.rows
      .filter((row) => !row.verdict.flagged)
      .map((row) => ({ name: row.quantity.name, value: fmtNum(row.quantity) })),
  }
}

// `services` keeps the atomic no-write-on-failure contract directly testable without network or
// Claude calls. Production callers pass only onStage.
export async function refreshSavedPaperEvidence(paper, { onStage, services = {} } = {}) {
  const run = services.runPaper || runPaper
  const summarize = services.triage || triage
  const loadProfile = services.getProfile || getProfile
  const readPaper = services.getPaper || ((id) => store.get('papers', id))
  const writePaper = services.putPaper || ((id, record) => store.put('papers', id, record))
  const writeFile = services.depositPaper || depositPaperToLibrary
  const recordEvent = services.logEvent || logEvent

  if (!needsDigestDetails(paper)) throw new Error('This paper already has current digest details.')

  const id = String(paper.pmid)
  const target = {
    id: String(paper.id || id),
    pmid: id,
    pmcid: paper.pmcid || null,
    nct: paper.nct || null,
    title: paper.title || null,
  }
  const res = await run(target, {
    onStage: (_paperId, stage) => onStage?.(stage),
  })
  if (res?.error || res?.retracted) {
    throw new Error(res?.error || 'This paper could not be re-read.')
  }

  onStage?.('summarizing')
  const profile = await loadProfile()
  const rankings = await summarize({
    northStars: profile?.northStars ?? [],
    projects: profile?.projects ?? [],
    journalPreferences: profile?.journalPreferences,
    rubric: profile?.rubric?.criteria ?? '',
    candidates: [candidateFromResult(res, id)],
  })
  const take = rankings.find((ranking) => String(ranking.id) === id)
  if (!String(take?.finding || '').trim()) {
    throw new Error('Claude did not return a usable summary. The saved paper was not changed.')
  }

  // Re-read the stored record immediately before the one write so note/tag edits made while the
  // paid run was in flight win. No partially refreshed record is ever persisted.
  onStage?.('saving')
  const current = await readPaper(paper.id)
  if (!current) throw new Error('This paper is no longer in the Library.')
  const fresh = buildPaperRecord(res, take, {
    title: res.citation?.title || res.paper.title || paper.title,
    source: current.saveSource || paper.saveSource || 'manual',
  })
  const next = mergeRefreshedEvidence(current, fresh)
  await writePaper(current.id, next)
  recordEvent('paper_evidence_refreshed', { pmid: next.pmid, source: 'library' })
  try {
    await writeFile(next)
  } catch (err) {
    console.warn('Updated Library file write failed (account record is current):', err.message)
  }
  onStage?.('done')
  return next
}
