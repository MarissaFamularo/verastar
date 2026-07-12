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

// --- topics: the broad hub tier, resolved from the graph's taxonomy edges ---
// For a single-specialty reader the DOMAIN filter collapses to one useless chip (everything
// is "Vascular Surgery") — the browsing altitude she actually wants is the HUB tier
// ("Carotid Revascularization", "CLTI Management"), whose growth the classifier already caps
// by strongly preferring existing hubs. These helpers surface that tier as filter chips.

// satellite conceptId → hub conceptId, from the graph's taxonomy edges.
export function hubMap(edges) {
  const m = new Map()
  for (const e of edges || []) {
    if (e?.origin === 'taxonomy' && e.source && e.target) m.set(e.source, e.target)
  }
  return m
}

// The topic chips: hubs that (transitively) hold ≥1 filed paper, with counts,
// most-populated first. A hub holding papers directly counts as its own topic.
export function listTopics(concepts, papers, edges) {
  const byId = new Map((concepts || []).map((c) => [c.id, c]))
  const m = hubMap(edges)
  const counts = new Map()
  for (const p of papers || []) {
    const home =
      p.conceptId && byId.has(p.conceptId)
        ? p.conceptId
        : (concepts || []).find((c) => (c.sourcePmids || []).includes(String(p.pmid)))?.id || null
    if (!home) continue
    const c = byId.get(home)
    const hub = c.isHub ? c.id : m.get(c.id) || null
    if (!hub || !byId.has(hub)) continue
    counts.set(hub, (counts.get(hub) || 0) + 1)
  }
  return Array.from(counts, ([id, count]) => ({ id, label: byId.get(id).label, count })).sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  )
}

// Build the browsable KB.
//   concepts : the concept nodes (graphNodes, kind 'concept')
//   papers   : all saved KB papers
//   opts     : { query, domain, topic, edges } — domain/topic '' / 'all' means no filter;
//              edges (graphEdges) are only needed when a topic filter is active
//
// Returns { groups: [{ group, papers }], unfiled: [paper], counts }.
//   - A paper's home is its concept (conceptId), else any concept whose sourcePmids lists it, else
//     the unfiled bucket.
//   - Only concepts that actually hold papers are shown.
//   - Domain filter narrows to concepts of that domain (and unfiled papers of that domain).
//   - Topic filter narrows to concepts under that hub (the hub itself included); unfiled papers
//     belong to no hub, so an active topic hides the unfiled bucket.
//   - A concept shows if it OR any of its papers matches the query; a concept-field/empty-query
//     match shows all its papers, otherwise only the papers that matched.
export function buildKB(concepts, papers, { query = '', domain = '', topic = '', edges = [] } = {}) {
  const q = query.trim().toLowerCase()
  const domainOk = (d) => !domain || domain === 'all' || d === domain
  const topicActive = topic && topic !== 'all'
  const hubs = topicActive ? hubMap(edges) : null
  const topicOk = (c) => !topicActive || c.id === topic || hubs.get(c.id) === topic
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
    if (!topicOk(concept)) continue
    const selfMatch = conceptFieldsMatch(concept, q)
    const matchingPapers = src.filter((p) => paperFieldsMatch(p, q))
    if (!q || selfMatch || matchingPapers.length) {
      groups.push({ group: concept, papers: !q || selfMatch ? src : matchingPapers })
    }
  }
  groups.sort((a, b) => b.papers.length - a.papers.length || a.group.label.localeCompare(b.group.label))

  const unfiled = topicActive
    ? [] // unfiled papers hang under no hub — an active topic filter can't include them
    : (papers || [])
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
