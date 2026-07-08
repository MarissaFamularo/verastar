// lib/kb.js — pure search/filter for the Knowledge Base view.
//
// The KB is concept-first (mirroring the clinician's real KG): each concept node groups its source
// papers under one synthesized summary and sits in one broad DOMAIN. Browsing = list the concepts
// that hold papers (optionally narrowed to one domain) and search title/summary/tags across both
// the concept and its source papers. Kept pure (no store, no React) so it's unit-testable.

function hit(text, q) {
  if (!q) return true
  return String(text || '').toLowerCase().includes(q)
}

function conceptFieldsMatch(concept, q) {
  if (hit(concept.label, q) || hit(concept.summary, q)) return true
  return (concept.tags || []).some((t) => hit(t, q))
}

function paperFieldsMatch(paper, q) {
  if (hit(paper.title, q) || hit(paper.finding, q) || hit(paper.notes, q)) return true
  return (paper.tags || []).some((t) => hit(t, q))
}

// Build the browsable KB.
//   concepts : the concept nodes (graphNodes, kind 'concept')
//   papers   : all saved KB papers
//   opts     : { query, domain }  — domain '' / 'all' means no domain filter
//
// Returns { groups: [{ group, papers }], unfiled: [paper], counts }.
//   - A paper's home is its concept (conceptId), else any concept whose sourcePmids lists it, else
//     the unfiled bucket.
//   - Only concepts that actually hold papers are shown.
//   - Domain filter narrows to concepts of that domain (and unfiled papers of that domain).
//   - A concept shows if it OR any of its papers matches the query; a concept-field/empty-query
//     match shows all its papers, otherwise only the papers that matched.
export function buildKB(concepts, papers, { query = '', domain = '' } = {}) {
  const q = query.trim().toLowerCase()
  const domainOk = (d) => !domain || domain === 'all' || d === domain
  const byId = new Map((concepts || []).map((c) => [c.id, c]))

  const homeOf = (p) => {
    if (p.conceptId && byId.has(p.conceptId)) return p.conceptId
    return (concepts || []).find((c) => (c.sourcePmids || []).includes(String(p.pmid)))?.id || null
  }

  const grouped = new Map()
  const filed = new Set()
  for (const p of papers || []) {
    const h = homeOf(p)
    if (h) {
      if (!grouped.has(h)) grouped.set(h, [])
      grouped.get(h).push(p)
      filed.add(p.id)
    }
  }

  const groups = []
  for (const concept of concepts || []) {
    const src = grouped.get(concept.id) || []
    if (!src.length) continue // empty concepts aren't cards
    if (!domainOk(concept.domain)) continue
    const selfMatch = conceptFieldsMatch(concept, q)
    const matchingPapers = src.filter((p) => paperFieldsMatch(p, q))
    if (!q || selfMatch || matchingPapers.length) {
      groups.push({ group: concept, papers: !q || selfMatch ? src : matchingPapers })
    }
  }
  groups.sort((a, b) => b.papers.length - a.papers.length || a.group.label.localeCompare(b.group.label))

  const unfiled = (papers || [])
    .filter((p) => !filed.has(p.id))
    .filter((p) => domainOk(p.domain))
    .filter((p) => paperFieldsMatch(p, q))

  return {
    groups,
    unfiled,
    counts: {
      groups: groups.length,
      papers: groups.reduce((n, g) => n + g.papers.length, 0) + unfiled.length,
    },
  }
}
