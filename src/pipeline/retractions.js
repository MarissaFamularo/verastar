// PubMed retraction handling. Keep the classification pure so candidate filtering,
// save guards, and the Library all apply the same deliberately narrow rule.

const RETRACTED_TYPE = 'retracted publication'

function values(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

export function hasRetractedPublicationType(pubtypes) {
  return values(pubtypes).some((type) => String(type).trim().toLowerCase() === RETRACTED_TYPE)
}

function titleIndicatesRetraction(title) {
  const text = String(title || '').trim()
  return /^\[?retracted\]?\s*[:.\-]/i.test(text) || /\[retracted\]\s*\.?$/i.test(text)
}

// Supports live PubMed citations and older saved records, including legacy citations
// stored as a display string. "Retraction of Publication" is intentionally not matched:
// that is the notice, not the withdrawn article.
export function citationIndicatesRetraction(citation) {
  if (!citation) return false
  if (typeof citation === 'string') {
    return /\bretracted publication\b/i.test(citation) || titleIndicatesRetraction(citation)
  }
  return (
    citation.retracted === true ||
    hasRetractedPublicationType(citation.pubtypes || citation.publicationTypes) ||
    titleIndicatesRetraction(citation.title)
  )
}

export function paperIndicatesRetraction(paper) {
  return paper?.retracted === true || paper?.retraction?.retracted === true || citationIndicatesRetraction(paper?.citation)
}

export function retractionPatch(citation, checkedAt = new Date().toISOString()) {
  if (!citationIndicatesRetraction(citation)) return null
  return {
    retracted: true,
    retraction: {
      retracted: true,
      source: 'PubMed',
      checkedAt,
      reason: 'PubMed classifies this article as a Retracted Publication.',
    },
    citation: typeof citation === 'object' ? { ...citation, retracted: true } : citation,
  }
}

// Removing a retracted Library record must also remove its PMID from concept membership.
// The concept itself stays: it may have other papers, notes, and graph edges. Pure so the
// destructive path can be tested before it touches storage.
export function removePaperFromConcepts(concepts, paper) {
  const pmid = String(paper?.pmid ?? '')
  if (!pmid) return []
  return (concepts || [])
    .filter((node) => (node?.sourcePmids || []).map(String).includes(pmid))
    .map((node) => ({
      ...node,
      sourcePmids: (node.sourcePmids || []).filter((id) => String(id) !== pmid),
    }))
}

// Refresh current PubMed status for saved papers in bounded batches. Dependencies are
// injected to keep this behavior unit-testable and usable with either local or cloud stores.
export async function refreshSavedRetractions(
  papers,
  { fetchCurrent, persist, onPatch, batchSize = 100, now = () => new Date().toISOString() } = {},
) {
  const list = (papers || []).filter((paper) => paper?.pmid != null && paper.pmid !== '')
  if (!list.length || !fetchCurrent || !persist) return []
  const byPmid = new Map(list.map((paper) => [String(paper.pmid), paper]))
  const patched = []

  for (let start = 0; start < list.length; start += batchSize) {
    const batch = list.slice(start, start + batchSize)
    let citations
    try {
      citations = await fetchCurrent(batch.map((paper) => String(paper.pmid)))
    } catch {
      continue
    }
    for (const citation of citations || []) {
      const paper = byPmid.get(String(citation?.pmid))
      if (!paper || paperIndicatesRetraction(paper)) continue
      const patch = retractionPatch(citation, now())
      if (!patch) continue
      // The batched status citation is intentionally lean and may omit saved DOI/URL fields.
      // Preserve the richer stored citation while adding current PubMed status.
      if (paper.citation && typeof paper.citation === 'object' && patch.citation && typeof patch.citation === 'object') {
        patch.citation = { ...paper.citation, ...patch.citation }
      }
      const next = { ...paper, ...patch }
      await persist(paper.id, next)
      patched.push({ id: paper.id, patch })
      onPatch?.(paper.id, patch)
    }
  }
  return patched
}
