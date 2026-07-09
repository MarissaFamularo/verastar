// pipeline/graph.js — the knowledge-graph data layer ("Constellations").
//
// A living star map of the clinician's knowledge: north stars + projects are the fixed
// anchor stars (synced from the steering profile); saved papers are smaller stars added
// as they're deposited. Connections are edges. The trust rule mirrors the verifier: the
// app never ASSERTS a link — it PROPOSES one (a `suggested` edge, dashed + pulsing) and
// the clinician confirms it (promoting it to `confirmed`). Suggestions come from two
// places: cheap structural noticing here (shared anchors, name mentions — no API), and
// Claude's semantic proposals (pipeline/connect.js). Both are proposals you dispose of.
//
// Everything persists through store.js (graphNodes / graphEdges) like the rest of the app.

import { store } from '../lib/store.js'
import { conceptId } from './concepts.js'

// --- id schemes (stable, so re-syncing never duplicates a node) ---

export function anchorId(kind, label) {
  return `${kind === 'project' ? 'proj' : 'ns'}:${label.trim().toLowerCase()}`
}

// re-exported so callers have one import for node ids
export { conceptId }

// Edges are UNDIRECTED — the id is the sorted endpoint pair, so (a,b) and (b,a) collapse
// to one edge and re-proposing an existing link is a no-op instead of a duplicate.
export function edgeId(a, b) {
  return [a, b].sort().join('~~')
}

// --- load ---

export async function loadGraph() {
  const [nodes, edges] = await Promise.all([store.all('graphNodes'), store.all('graphEdges')])
  return { nodes: nodes || [], edges: edges || [] }
}

// --- anchor sync: the profile is the source of truth for north-star + project stars ---

// Ensure a PROJECT node exists for every current profile project (projects appear on the map as
// yellow nodes, like her real KG). North stars are NOT map nodes — they steer the digest/rubric,
// not the graph — so any legacy north-star node (and its edges) is swept here. Add-only for
// projects: a project the user later drops just stops being re-created. Returns the project nodes.
export async function syncAnchors(profile) {
  const existing = (await store.all('graphNodes')) || []
  const byId = new Map(existing.map((n) => [n.id, n]))

  // sweep any legacy north-star nodes + edges that touch them (they're no longer map nodes)
  const northStars = existing.filter((n) => n.kind === 'northStar')
  if (northStars.length) {
    const edges = (await store.all('graphEdges')) || []
    const nsIds = new Set(northStars.map((n) => n.id))
    await Promise.all([
      ...northStars.map((n) => store.delete('graphNodes', n.id)),
      ...edges.filter((e) => nsIds.has(e.source) || nsIds.has(e.target)).map((e) => store.delete('graphEdges', e.id)),
    ])
  }

  const projects = []
  for (const label of profile?.projects ?? []) {
    if (!label?.trim()) continue
    const id = anchorId('project', label)
    const node = byId.get(id) || {
      id,
      kind: 'project',
      label,
      text: label,
      sourcePmids: [],
      summary: '',
      addedAt: new Date().toISOString(),
    }
    projects.push(node)
  }

  await Promise.all(projects.map((n) => store.put('graphNodes', n.id, n)))
  return projects
}

// --- concept stars (the graph nodes are concepts, not individual papers) ---

// The concept nodes currently on the map.
export async function loadConcepts() {
  const nodes = (await store.all('graphNodes')) || []
  return nodes.filter((n) => n.kind === 'concept')
}

// Create or update a concept star. Matching is by name (via conceptId slug) so re-using a
// name collapses to one node. `domain` (one of the 6 keys) colors it. `sourcePmids` is the set
// of papers filed under it; `text` (label + tags + summary) is what the structural noticer keys
// off. Tags are capped so a concept accreting every source paper's tags doesn't become a firehose.
const CONCEPT_TAG_CAP = 12
export async function upsertConcept({ name, domain = null, tags = [], summary = '', sourcePmids = [], isHub = false }) {
  const id = conceptId(name)
  const existing = await store.get('graphNodes', id)
  const mergedPmids = Array.from(new Set([...(existing?.sourcePmids || []), ...sourcePmids.map(String)]))
  const mergedTags = Array.from(new Set([...(existing?.tags || []), ...tags])).slice(0, CONCEPT_TAG_CAP)
  const node = {
    id,
    kind: 'concept',
    label: existing?.label || name,
    domain: domain ?? existing?.domain ?? null,
    tags: mergedTags,
    summary: summary || existing?.summary || '',
    sourcePmids: mergedPmids,
    // isHub is sticky OR: once any satellite names a node as its hub, it stays a hub even if a
    // later paper files papers directly under it (a node can be both a hub and hold sources).
    isHub: isHub || existing?.isHub || false,
    text: [name, ...mergedTags, summary || existing?.summary || ''].filter(Boolean).join(' '),
    addedAt: existing?.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await store.put('graphNodes', id, node)
  return node
}

// Link a specific concept (satellite) to its broad hub with a CONFIRMED "taxonomy" edge — the
// map's skeleton. Unlike a proposed connection, this is structural truth ("X is part of Y"), so it
// draws solid immediately rather than waiting to be charted. No-op on a self-link (concept == hub)
// or if the pair is already confirmed. Returns the stored edge, or null.
export async function linkToHub(satelliteId, hubId, hubLabel = '') {
  if (!satelliteId || !hubId || satelliteId === hubId) return null
  const id = edgeId(satelliteId, hubId)
  const existing = await store.get('graphEdges', id)
  if (existing?.status === 'confirmed') return existing
  const edge = {
    id,
    source: satelliteId,
    target: hubId,
    status: 'confirmed',
    origin: 'taxonomy',
    rationale: hubLabel ? `part of “${hubLabel}”` : 'part of a broader topic',
    ts: existing?.ts || new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
  }
  await store.put('graphEdges', id, edge)
  return edge
}

// Attach a paper (by pmid) to a concept, without disturbing its summary/domain.
export async function attachPaperToConcept(name, pmid) {
  return upsertConcept({ name, sourcePmids: [String(pmid)] })
}

// Replace a concept's tag list — used by the KB "prune" UI (Claude auto-applies tags, the
// clinician removes wrong ones). Unlike upsertConcept (add-only union), this SETS the tags, so
// a removed tag stays gone. `text` is kept in sync so the structural noticer re-keys off it.
export async function setConceptTags(id, tags) {
  const existing = await store.get('graphNodes', id)
  if (!existing) return null
  const clean = Array.from(new Set((tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)))
  const node = {
    ...existing,
    tags: clean,
    text: [existing.label, ...clean, existing.summary || ''].filter(Boolean).join(' '),
    updatedAt: new Date().toISOString(),
  }
  await store.put('graphNodes', id, node)
  return node
}

// Update just the synthesized summary of an existing concept.
export async function setConceptSummary(id, summary) {
  const existing = await store.get('graphNodes', id)
  if (!existing) return null
  const node = { ...existing, summary, text: [existing.label, ...(existing.tags || []), summary].filter(Boolean).join(' '), updatedAt: new Date().toISOString() }
  await store.put('graphNodes', id, node)
  return node
}

export async function removeNode(id) {
  await store.delete('graphNodes', id)
  // Sweep any edges that touched it so the map never draws a line to nothing.
  const edges = (await store.all('graphEdges')) || []
  await Promise.all(
    edges.filter((e) => e.source === id || e.target === id).map((e) => store.delete('graphEdges', e.id)),
  )
}

// --- edges: propose, confirm, dispose ---

// Add a connection between two nodes. Connections are made automatically (structural noticing +
// Claude) and just APPEAR — there is no manual "chart it" step (the clinician wanted her real KG's
// behaviour: links form on their own; the map is light until you hover a star). So an edge is
// created 'confirmed' outright. No-op on a self-link or an already-existing edge. `proposeEdge` is
// the historical name (still called by connect.js / the structural refresh); it no longer proposes
// a pending "maybe" — it links.
export async function proposeEdge({ source, target, rationale = '', origin = 'structural' }) {
  if (source === target) return null
  const id = edgeId(source, target)
  const existing = await store.get('graphEdges', id)
  if (existing) return existing
  const edge = {
    id,
    source,
    target,
    status: 'confirmed',
    origin, // 'structural' | 'claude' | 'taxonomy'
    rationale,
    ts: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
  }
  await store.put('graphEdges', id, edge)
  return edge
}

// One-time migration: promote any lingering 'suggested' edge (from the old confirm-ritual model)
// to a real connection, so nothing sits waiting to be manually charted. Returns count promoted.
export async function confirmAllEdges() {
  const edges = (await store.all('graphEdges')) || []
  const pending = edges.filter((e) => e.status !== 'confirmed')
  await Promise.all(
    pending.map((e) =>
      store.put('graphEdges', e.id, { ...e, status: 'confirmed', confirmedAt: e.confirmedAt || new Date().toISOString() }),
    ),
  )
  return pending.length
}

// Promote a suggestion to a confirmed constellation line (this is the "chart it" moment the
// reveal animation celebrates). A manual link the user draws is confirmed outright.
export async function confirmEdge(id, patch = {}) {
  const existing = (await store.get('graphEdges', id)) || {}
  const edge = { ...existing, id, status: 'confirmed', confirmedAt: new Date().toISOString(), ...patch }
  await store.put('graphEdges', id, edge)
  return edge
}

export async function dismissEdge(id) {
  await store.delete('graphEdges', id)
}

// --- structural noticing (free, no API — the "the app quietly noticed" magic) ---

function includesLabel(text, label) {
  if (!text || !label) return false
  return text.toLowerCase().includes(label.trim().toLowerCase())
}

// Compute NEW suggested edges from structure alone — never touching confirmed edges or
// re-proposing pairs that already exist. Two kinds:
//   1. paper → anchor : the paper's text names the north star / project.
//   2. paper → paper  : two papers already tied to the SAME anchor (the serendipitous one —
//      "you didn't draw this, but these two belong together").
// Returns edge specs to hand to proposeEdge; the caller persists them.
export function structuralSuggestions(nodes, edges) {
  const anchors = nodes.filter((n) => n.kind === 'northStar' || n.kind === 'project')
  // "content" nodes = concepts (the graph's non-anchor nodes). Kept general so the same
  // pass works whether a build uses concept nodes or (legacy) paper nodes.
  const papers = nodes.filter((n) => n.kind !== 'northStar' && n.kind !== 'project')
  const has = new Set(edges.map((e) => e.id))
  const out = []
  const push = (a, b, rationale) => {
    const id = edgeId(a, b)
    if (has.has(id) || out.some((o) => edgeId(o.source, o.target) === id)) return
    out.push({ source: a, target: b, rationale, origin: 'structural' })
  }

  // 1. name mentions
  for (const p of papers) {
    for (const a of anchors) {
      if (includesLabel(p.text, a.label)) push(p.id, a.id, `mentions “${a.label}”`)
    }
  }

  // 2. shared-anchor serendipity — build anchor -> papers tied to it (via ANY existing edge
  //    plus the mentions we just found), then link co-anchored paper pairs.
  const tiedByAnchor = new Map() // anchorId -> Set(paperId)
  const tie = (paperId, anchorId_) => {
    if (!tiedByAnchor.has(anchorId_)) tiedByAnchor.set(anchorId_, new Set())
    tiedByAnchor.get(anchorId_).add(paperId)
  }
  const anchorIds = new Set(anchors.map((a) => a.id))
  const paperIds = new Set(papers.map((p) => p.id))
  for (const e of edges) {
    if (paperIds.has(e.source) && anchorIds.has(e.target)) tie(e.source, e.target)
    if (paperIds.has(e.target) && anchorIds.has(e.source)) tie(e.target, e.source)
  }
  for (const o of out) tie(o.source, o.target) // include fresh mentions

  const labelOf = new Map(anchors.map((a) => [a.id, a.label]))
  for (const [aId, set] of tiedByAnchor) {
    const ids = [...set]
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        push(ids[i], ids[j], `both connect to “${labelOf.get(aId)}”`)
      }
    }
  }

  // 3. shared TAG serendipity — two papers carrying the same specific topic tag. Skip tags
  //    shared by too many papers (they behave like a domain and would over-connect the map).
  const TAG_MAX_FANOUT = 5
  const byTag = new Map() // tag -> [paperId]
  for (const p of papers) {
    for (const t of p.tags || []) {
      const tag = String(t).trim().toLowerCase()
      if (!tag) continue
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag).push(p.id)
    }
  }
  for (const [tag, ids] of byTag) {
    if (ids.length < 2 || ids.length > TAG_MAX_FANOUT) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        push(ids[i], ids[j], `both tagged “${tag}”`)
      }
    }
  }

  return out
}

// Convenience: run structural noticing and persist the new suggestions. Returns how many
// were added, so the UI can say "3 new connections noticed."
export async function refreshStructuralSuggestions() {
  const { nodes, edges } = await loadGraph()
  const specs = structuralSuggestions(nodes, edges)
  await Promise.all(specs.map((s) => proposeEdge(s)))
  return specs.length
}
