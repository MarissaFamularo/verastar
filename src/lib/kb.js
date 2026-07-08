// lib/kb.js — pure search/filter for the Knowledge Base view.
//
// The KB mirrors the clinician's own graph hierarchy: categories (their north stars + projects)
// → grouping nodes → source papers. A grouping node is either a CONCEPT (a finer topic beneath a
// category) or a CATEGORY ANCHOR itself (when a paper's topic IS a north star, it files directly
// under the anchor — no separate concept). Browsing lists the grouping nodes that hold papers,
// optionally narrowed to one category, and searches title/summary/tags across both the group and
// its papers. Kept pure (no store, no React) so it's unit-testable and the component just renders.

function hit(text, q) {
  if (!q) return true
  return String(text || '').toLowerCase().includes(q)
}

const isCategoryNode = (n) => n?.kind === 'northStar' || n?.kind === 'project'

// A grouping node's category = itself (if it's an anchor) or its parent (if it's a concept).
const categoryOf = (node) => (isCategoryNode(node) ? node.id : node.category)

function groupFieldsMatch(node, q) {
  if (hit(node.label, q) || hit(node.summary, q)) return true
  return (node.tags || []).some((t) => hit(t, q))
}

function paperFieldsMatch(paper, q) {
  if (hit(paper.title, q) || hit(paper.finding, q) || hit(paper.notes, q)) return true
  return (paper.tags || []).some((t) => hit(t, q))
}

// Build the browsable KB.
//   nodes  : all graph nodes (concepts + category anchors)
//   papers : all saved KB papers
//   opts   : { query, category }  — category '' / 'all' means no category filter; otherwise an
//            anchor id (a north star / project)
//
// Returns { groups: [{ group, papers }], unfiled: [paper], counts }.
//   - A paper's home node is its concept (conceptId), else the anchor it's filed directly under
//     (paper.category with no conceptId), else any node whose sourcePmids lists it, else unfiled.
//   - Only grouping nodes that actually hold papers are shown (bare categories are just filters).
//   - Category filter narrows to groups (and unfiled papers) of that category.
//   - A group shows if it OR any of its papers matches the query; a group-field/empty-query match
//     shows all its papers, otherwise only the papers that matched.
export function buildKB(nodes, papers, { query = '', category = '' } = {}) {
  const q = query.trim().toLowerCase()
  const catOk = (c) => !category || category === 'all' || c === category
  const byId = new Map((nodes || []).map((n) => [n.id, n]))

  const homeOf = (p) => {
    if (p.conceptId && byId.has(p.conceptId)) return p.conceptId
    if (!p.conceptId && p.category && isCategoryNode(byId.get(p.category))) return p.category
    return (nodes || []).find((n) => (n.sourcePmids || []).includes(String(p.pmid)))?.id || null
  }

  const grouped = new Map() // nodeId -> [paper]
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
  for (const node of nodes || []) {
    const src = grouped.get(node.id) || []
    if (!src.length) continue // bare categories/empty concepts aren't cards
    if (!catOk(categoryOf(node))) continue
    const selfMatch = groupFieldsMatch(node, q)
    const matchingPapers = src.filter((p) => paperFieldsMatch(p, q))
    if (!q || selfMatch || matchingPapers.length) {
      groups.push({ group: node, papers: !q || selfMatch ? src : matchingPapers })
    }
  }
  groups.sort((a, b) => b.papers.length - a.papers.length || a.group.label.localeCompare(b.group.label))

  const unfiled = (papers || [])
    .filter((p) => !filed.has(p.id))
    .filter((p) => catOk(p.category || ''))
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
