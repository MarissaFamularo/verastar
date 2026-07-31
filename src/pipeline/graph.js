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
import { getTrellisProjects, getTrellisExcluded, consideredProjects } from '../lib/trellis.js'

// --- id schemes (stable, so re-syncing never duplicates a node) ---

export function anchorId(kind, label) {
  return `${kind === 'project' ? 'proj' : 'ns'}:${label.trim().toLowerCase()}`
}

// PaperTrellis project stars key off the PT row id, not the title — a renamed project keeps
// its star (and its edges) instead of minting a duplicate.
export function trellisNodeId(ptId) {
  return `proj:pt-${ptId}`
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

  // Starred PaperTrellis projects are project stars too. The sweep runs ONLY off a cache
  // that has actually synced (syncedAt set): an empty read — signed out, cold boot before
  // the background refresh lands, transient failure — must never be read as "she un-starred
  // everything", because the sweep deletes the stars' edges (including Claude-made links)
  // permanently. Proven the hard way in a signed-out repro.
  const [cache, excluded] = await Promise.all([getTrellisProjects(), getTrellisExcluded()])
  const { nodes: ptNodes, staleIds: rawStale } = trellisAnchorNodes(existing, consideredProjects(cache, excluded))
  const staleIds = cache?.syncedAt ? rawStale : []
  projects.push(...ptNodes)
  if (staleIds.length) {
    const edges = (await store.all('graphEdges')) || []
    const stale = new Set(staleIds)
    await Promise.all([
      ...staleIds.map((id) => store.delete('graphNodes', id)),
      ...edges.filter((e) => stale.has(e.source) || stale.has(e.target)).map((e) => store.delete('graphEdges', e.id)),
    ])
  }

  await Promise.all(projects.map((n) => store.put('graphNodes', n.id, n)))
  return projects
}

// The PaperTrellis slice of the anchor sync, pure so the sweep is testable without a store.
// PT nodes are REBUILT from the starred sync on every load (title/desc edits flow through;
// addedAt survives); a PT node whose project is un-starred or past submission is stale and
// leaves the map. `desc` rides on the node because the keyword matcher needs more than the
// title; capped so an abstract-length description doesn't bloat the row.
const PT_DESC_MAX = 200
export function trellisAnchorNodes(existingNodes, starred) {
  const byId = new Map((existingNodes || []).map((n) => [n.id, n]))
  const nodes = (starred || []).map((p) => {
    const id = trellisNodeId(p.id)
    const desc = String(p.description || '').trim().slice(0, PT_DESC_MAX)
    return {
      id,
      kind: 'project',
      label: p.title,
      desc,
      text: [p.title, desc].filter(Boolean).join(' '),
      sourcePmids: [],
      summary: '',
      source: 'papertrellis',
      ptId: p.id,
      addedAt: byId.get(id)?.addedAt || new Date().toISOString(),
    }
  })
  const keep = new Set(nodes.map((n) => n.id))
  const staleIds = (existingNodes || [])
    .filter((n) => n.source === 'papertrellis' && !keep.has(n.id))
    .map((n) => n.id)
  return { nodes, staleIds }
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
    origin, // 'structural' | 'keyword' | 'claude' | 'taxonomy'
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

// Anchor labels are org-flavored ("Carotid Revascularization Initiative") while concept text
// speaks science ("carotid revascularization") — so a verbatim-label match never fires. Strip
// generic effort-words from the label's ends and match on the remaining core phrase.
const GENERIC_ANCHOR_WORDS = new Set([
  'initiative', 'program', 'programme', 'project', 'study', 'effort',
  'center', 'centre', 'group', 'lab', 'plan', 'pilot', 'committee',
])
export function coreAnchorPhrase(label) {
  const words = (label || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  while (words.length > 1 && GENERIC_ANCHOR_WORDS.has(words[words.length - 1])) words.pop()
  while (words.length > 1 && GENERIC_ANCHOR_WORDS.has(words[0])) words.shift()
  return words.join(' ')
}

// --- keyword matching: how an anchor finds content that never spells out its name ---

// Crude one-pass suffix strip — enough that aneurysm/aneurysms and prediction/predictive land
// on one stem without a dependency. Both sides of a comparison pass through the same function,
// so a mangled stem ("poplite") is still a stable key. Longest suffix first; the remainder must
// keep 4+ chars so short tokens survive intact.
const STEM_SUFFIXES = ['ations', 'ation', 'ities', 'ility', 'ical', 'ives', 'ions', 'ies', 'ive', 'ion', 'ing', 'ics', 'ic', 'als', 'al', 'ers', 'er', 'es', 's', 'e', 'y']
function stemToken(w) {
  for (const suf of STEM_SUFFIXES) {
    if (w.length - suf.length >= 4 && w.endsWith(suf)) return w.slice(0, -suf.length)
  }
  return w
}

// Tokens that appear in nearly any project title or paper text and therefore carry no linking
// signal: function words, generic research/effort words, and universal clinical words. Compared
// post-stem, so one listed form usually covers its plural/derived siblings.
const MATCH_STOPWORDS = [
  // function words
  'a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'in', 'on', 'for', 'to', 'with', 'without',
  'by', 'at', 'from', 'into', 'onto', 'over', 'under', 'about', 'across', 'among', 'between',
  'within', 'during', 'after', 'before', 'versus', 'via', 'per', 'than', 'then', 'when', 'where',
  'which', 'who', 'what', 'how', 'why', 'is', 'are', 'was', 'were', 'be', 'being', 'been', 'do',
  'does', 'did', 'has', 'have', 'had', 'can', 'could', 'will', 'would', 'should', 'may', 'might',
  'must', 'not', 'non', 'its', 'this', 'that', 'these', 'those', 'their', 'our', 'all', 'any',
  'each', 'both', 'more', 'most', 'less', 'least', 'other', 'same', 'such', 'only', 'also',
  'new', 'novel', 'current', 'recent', 'early', 'late', 'first', 'second', 'ongoing', 'long',
  'short', 'term',
  // generic research/effort words
  'study', 'studies', 'research', 'program', 'programme', 'project', 'projects', 'initiative',
  'initiatives', 'effort', 'efforts', 'pilot', 'plan', 'plans', 'planning', 'committee',
  'center', 'centre', 'group', 'groups', 'lab', 'labs', 'team', 'work', 'working', 'draft',
  'paper', 'papers', 'manuscript', 'manuscripts', 'abstract', 'abstracts', 'submission',
  'chapter', 'review', 'reviews', 'analysis', 'analyses', 'model', 'models', 'modeling',
  'modelling', 'outcome', 'outcomes', 'result', 'results', 'effect', 'effects', 'impact',
  'impacts', 'role', 'roles', 'association', 'associations', 'associated', 'correlation',
  'comparison', 'compare', 'compared', 'comparing', 'evaluation', 'evaluate', 'evaluating',
  'assessment', 'assess', 'assessing', 'approach', 'approaches', 'method', 'methods',
  'methodology', 'protocol', 'protocols', 'cohort', 'cohorts', 'registry', 'registries',
  'database', 'databases', 'data', 'dataset', 'datasets', 'trial', 'trials', 'series',
  'report', 'reports', 'case', 'cases', 'aim', 'aims', 'objective', 'objectives',
  'hypothesis', 'finding', 'findings', 'rate', 'rates', 'ratio', 'trend', 'trends',
  'level', 'levels', 'use', 'uses', 'using', 'used', 'based',
  // universal clinical words
  'clinic', 'clinics', 'clinical', 'clinically', 'patient', 'patients', 'medical', 'medicine',
  'health', 'healthcare', 'care', 'hospital', 'hospitals', 'disease', 'diseases',
]
const STOP_STEMS = new Set(MATCH_STOPWORDS.map(stemToken))

// Significant stems of a text: lowercase, parentheticals dropped (org garnish like "(ORBIT)",
// not topic), punctuation split, stopwords and numbers out. Returns stem -> first original form,
// so a rationale can name real words instead of stems.
export function significantTokens(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
  const out = new Map()
  for (const w of cleaned.split(' ')) {
    if (w.length < 3 || /^\d+$/.test(w)) continue
    const s = stemToken(w)
    if (STOP_STEMS.has(s)) continue
    if (!out.has(s)) out.set(s, w)
  }
  return out
}

// Does this anchor plausibly own this concept? Shared significant stems between the anchor's
// label+description and the concept's label+tags+text. Two distinct hits make a match — one
// generic-ish token alone can't link — EXCEPT an anchor with a single significant token, which
// gets to match on it (that one token is the whole topic). Returns { tokens, score } or null;
// tokens are the anchor's word forms, for the rationale.
export function anchorMatch(anchorText, concept) {
  const at = significantTokens(anchorText)
  if (at.size === 0) return null
  const ct = significantTokens([concept.label, ...(concept.tags || []), concept.text || ''].filter(Boolean).join(' '))
  const shared = []
  for (const [s, orig] of at) if (ct.has(s)) shared.push(orig)
  if (shared.length < (at.size === 1 ? 1 : 2)) return null
  return { tokens: shared, score: shared.length }
}

// Compute NEW suggested edges from structure alone — never touching confirmed edges or
// re-proposing pairs that already exist. Two kinds:
//   1. paper → anchor : the paper's text names the north star / project — or shares enough
//      significant keywords with it (anchorMatch) that the name never had to appear.
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
  const push = (a, b, rationale, origin = 'structural') => {
    const id = edgeId(a, b)
    if (has.has(id) || out.some((o) => edgeId(o.source, o.target) === id)) return false
    out.push({ source: a, target: b, rationale, origin })
    return true
  }

  // 1. name mentions — matched on the anchor's CORE phrase (see coreAnchorPhrase), and only
  //    against hubs or hub-less concepts: a project ties to the topic star, not to every
  //    satellite under it (which would hairball the map with near-duplicate dashed edges).
  const satellites = new Set(edges.filter((e) => e.origin === 'taxonomy').map((e) => e.source))
  for (const p of papers) {
    if (satellites.has(p.id)) continue
    for (const a of anchors) {
      const core = coreAnchorPhrase(a.label)
      const phrase = core.length >= 6 ? core : (a.label || '').trim().toLowerCase()
      if (includesLabel(p.text, phrase)) push(p.id, a.id, `mentions “${phrase}”`)
    }
  }

  // 1b. keyword overlap — the mention path needs the anchor's core phrase verbatim, so
  //     "Pop Artery Aneurysm (ORBIT)" never finds "Popliteal Artery Aneurysm"; this path
  //     fires on shared significant tokens instead (anchorMatch, label+desc vs the concept's
  //     text). Capped per anchor, best scores first, so a broad project can't spray the map.
  //     Same hub-only rule as mentions. Tagged origin 'keyword' so pass 2 can tell these
  //     recall ties apart from a real name-mention.
  const KEYWORD_EDGE_CAP = 12
  for (const a of anchors) {
    const anchorText = [a.label, a.desc || ''].filter(Boolean).join(' ')
    const candidates = []
    for (const p of papers) {
      if (satellites.has(p.id)) continue
      const m = anchorMatch(anchorText, p)
      if (m) candidates.push({ p, m })
    }
    candidates.sort((x, y) => y.m.score - x.m.score)
    let gained = 0
    for (const { p, m } of candidates) {
      if (gained >= KEYWORD_EDGE_CAP) break
      if (push(p.id, a.id, `shares “${m.tokens.join(', ')}” with “${a.label}”`, 'keyword')) gained++
    }
  }

  // 2. shared-anchor serendipity — build anchor -> papers tied to it (via ANY existing edge
  //    plus the mentions we just found), then link co-anchored paper pairs. Keyword ties are
  //    left out on BOTH sides: a capped 12-tie project would otherwise mint 66 pairwise
  //    "serendipity" edges — spray with one step of laundering.
  const tiedByAnchor = new Map() // anchorId -> Set(paperId)
  const tie = (paperId, anchorId_) => {
    if (!tiedByAnchor.has(anchorId_)) tiedByAnchor.set(anchorId_, new Set())
    tiedByAnchor.get(anchorId_).add(paperId)
  }
  const anchorIds = new Set(anchors.map((a) => a.id))
  const paperIds = new Set(papers.map((p) => p.id))
  // Keyword AND claude edges are excluded from the tie set: both can legitimately give one
  // anchor many links (a Claude pass returns up to ~10), and pairwise-linking everything a
  // popular anchor touches mints C(n,2) filler edges — 8 links became 28 extras, live.
  for (const e of edges) {
    if (e.origin === 'keyword' || e.origin === 'claude') continue
    if (paperIds.has(e.source) && anchorIds.has(e.target)) tie(e.source, e.target)
    if (paperIds.has(e.target) && anchorIds.has(e.source)) tie(e.target, e.source)
  }
  for (const o of out) {
    if (o.origin === 'keyword') continue
    tie(o.source, o.target) // include fresh mentions
  }

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
