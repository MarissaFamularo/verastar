// pipeline/categorize.js — the CATEGORY layer: every user's library self-organizes into at
// most 10 shelves (up to 9 named + "Other"), minted BY THE MODEL from that user's actual
// concepts — never from a hardcoded specialty list. A category IS a hub node (isHub:true);
// whatever ids existing hubs carry (the migration's `concept:cat-*`, or slugs minted here),
// the current isHub set is the category set. Satellites file under a category via one
// confirmed taxonomy edge — the same skeleton kb.js topicIndex / listTopics already read.
//
// A sibling of concepts.js rather than more weight inside it: concepts.js holds the three
// per-item calls (file one paper, summarize one concept, tidy the domain fields); this is a
// LIBRARY-WIDE pass with its own plan/apply machinery, and the split keeps both testable.
//
// The shape mirrors the house rule everywhere else: the model proposes, the code disposes.
// One structured call proposes shelves; planCategorization() (pure) sanitizes — cap to 9
// largest, never rename an existing category, don't churn stable assignments, everything
// unassigned falls to Other — and applyPlan() writes in crash-safe order.

import { extractStructured, MODELS } from '../lib/anthropic.js'
import { store } from '../lib/store.js'
import { conceptId, OTHER_LABEL } from './concepts.js'
import { loadGraph, edgeId } from './graph.js'

export const CATEGORY_CAP = 9 // named shelves; Other makes at most 10
export const MAX_CATEGORIES = 10
export const REORG_UNFILED_MIN = 8 // this many shelf-less concepts triggers a reorganize

const norm = (s) => (s || '').trim().toLowerCase()

// The one-line description a shelf node carries. Honest by construction: it describes the
// SHELF (what's grouped here), never the evidence — evidence summaries belong to concept
// nodes that actually hold sources, written by synthesizeConcept from verified findings.
export function shelfSummary(label) {
  if (norm(label) === norm(OTHER_LABEL)) return 'Papers that don’t yet fit one of this library’s named categories.'
  return `A category shelf gathering this library’s work on ${label}.`
}

// --- gating (pure) ---

// The free no-op check: the library is already organized when the hub count is within the
// cap AND every satellite has a taxonomy edge to a real hub. categorizeLibrary() returns
// without a model call in that case, so firing it speculatively costs nothing.
export function isCategorized(concepts, edges) {
  const all = concepts || []
  const hubIds = new Set(all.filter((c) => c.isHub).map((c) => c.id))
  if (hubIds.size > MAX_CATEGORIES) return false
  const filed = new Set(
    (edges || []).filter((e) => e?.origin === 'taxonomy' && hubIds.has(e.target)).map((e) => e.source),
  )
  return all.every((c) => c.isHub || filed.has(c.id))
}

// The post-deposit trigger: reorganize when the shelf tier overflowed (a legacy ad-hoc
// library) or enough deposits have piled up shelf-less (a young library before its first
// organization, or a backlog of "no category fit" strays).
export function shouldReorganize(concepts, edges) {
  const all = concepts || []
  const hubIds = new Set(all.filter((c) => c.isHub).map((c) => c.id))
  if (hubIds.size > MAX_CATEGORIES) return true
  const filed = new Set(
    (edges || []).filter((e) => e?.origin === 'taxonomy' && hubIds.has(e.target)).map((e) => e.source),
  )
  const unfiled = all.filter((c) => !c.isHub && !filed.has(c.id))
  return unfiled.length >= REORG_UNFILED_MIN
}

// --- the model call ---

export const CATEGORIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['categories'],
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'memberIds'],
        properties: {
          label: { type: 'string' },
          memberIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

// Specialty-agnostic by design: the shelves must come from the concepts shown, so the only
// worked example is a deliberately generic one (no vascular anchors — an orthopod, an
// oncologist, and a health-policy researcher all get their own field's major areas).
const CATEGORIZE_SYSTEM = `You organize a clinician-scientist's saved research library into browsable categories. You get every concept in the library (id | label | tags) and the labels of any categories that already exist. Return at most ${CATEGORY_CAP} categories, each with the ids of the concepts that belong on that shelf.

Categories must be the natural shelves of THIS library at the altitude a clinician browses by — the major areas of their own field as this library actually spans them, whatever that field is. Not micro-topics (a shelf holding one concept is a topic, not a category) and not one giant bucket (a shelf holding nearly everything organizes nothing). As a neutral illustration only: a generic medical library might shelve into "Cardiology", "Imaging", and "Methods", with the rest falling to "${OTHER_LABEL}" — derive the real names from the concepts you are shown, never from that illustration.

Rules:
- REUSE an existing category label VERBATIM whenever it fits what you would file there. Never rename an existing category — a changed spelling counts as a brand-new category, not a rename.
- Assign each concept id to at most one category. Leave a concept out entirely when it fits no shelf — unassigned concepts fall to "${OTHER_LABEL}" automatically. Do NOT return an "${OTHER_LABEL}" category yourself.
- Category labels are short (1–4 words, Title Case).`

// One structured call: the whole concept list in, up to 9 shelves out. Same cheap tier as
// the per-paper classifier (this is metadata-only work).
export async function proposeCategories({ concepts, hubLabels, model = MODELS.triage, maxTokens = 4096 }) {
  const list = (concepts || [])
    .map((c) => `- ${c.id} | ${c.label}${c.tags?.length ? ` | ${c.tags.join(', ')}` : ''}`)
    .join('\n')
  const existing = hubLabels?.length ? hubLabels.map((l) => `- "${l}"`).join('\n') : '(none yet)'
  const content = `EXISTING CATEGORIES (reuse these labels verbatim where they fit):\n${existing}\n\nCONCEPTS (id | label | tags):\n${list}`
  const r = await extractStructured({
    model,
    system: CATEGORIZE_SYSTEM,
    content,
    schema: CATEGORIZE_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })
  return r.categories || []
}

// --- sanitize the proposal (pure) ---

// The in-code cap: more than `cap` named categories → keep the `cap` largest (stable order
// on ties), everything else's members go to Other. Returns { kept, overflow: memberIds }.
export function capCategories(categories, cap = CATEGORY_CAP) {
  const cats = categories || []
  if (cats.length <= cap) return { kept: cats, overflow: [] }
  const ranked = cats
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.memberIds.length - a.c.memberIds.length || a.i - b.i)
  const keep = new Set(ranked.slice(0, cap).map((x) => x.i))
  return {
    kept: cats.filter((_, i) => keep.has(i)),
    overflow: cats.flatMap((c, i) => (keep.has(i) ? [] : c.memberIds)),
  }
}

// Turn the model's raw categories into a concrete, store-ready plan. Pure — every rule the
// prompt states is re-enforced here, because the model proposes and the code disposes:
//   - a label matching an existing hub (case/space-insensitive) REUSES that hub node —
//     its id and stored label untouched, so an existing category is never renamed. Any
//     other label is a NEW category (slug id) and counts against the cap like one.
//   - >9 named categories → the 9 largest survive; the rest's members fall to Other.
//   - membership: first assignment wins; unknown ids are dropped; a shelf is never a
//     member of a shelf.
//   - a concept the model left unassigned KEEPS its current shelf if that shelf survived
//     (no churn of stable assignments); otherwise it falls to Other.
//   - Other materializes only when it has members (an existing Other hub is kept either way).
//   - hubs that didn't come back as categories are demoted and re-filed like any member.
export function planCategorization(raw, concepts, edges) {
  const all = concepts || []
  const byId = new Map(all.map((c) => [c.id, c]))
  const hubs = all.filter((c) => c.isHub)
  const hubByLabel = new Map(hubs.map((h) => [norm(h.label), h]))

  // Normalize the proposal: drop unknown members, merge duplicate labels; a category the
  // model labeled "Other" (against instructions) isn't a named shelf — pool its members.
  const pool = []
  const named = []
  const byLabel = new Map()
  for (const c of raw || []) {
    const label = (c?.label || '').trim()
    const memberIds = (c?.memberIds || []).filter((id) => byId.has(id))
    if (!label || norm(label) === norm(OTHER_LABEL)) {
      pool.push(...memberIds)
      continue
    }
    const prev = byLabel.get(norm(label))
    if (prev) prev.memberIds.push(...memberIds)
    else {
      const entry = { label, memberIds: [...memberIds] }
      byLabel.set(norm(label), entry)
      named.push(entry)
    }
  }

  const { kept, overflow } = capCategories(named)
  pool.push(...overflow)

  // Resolve labels to node ids (reuse-by-label keeps the existing node, whatever its id;
  // a new label slugs — colliding with an existing satellite means promotion, handled at
  // apply). Merge if two labels resolve to the same node.
  const shelves = []
  const shelfById = new Map()
  for (const c of kept) {
    const existing = hubByLabel.get(norm(c.label))
    const id = existing ? existing.id : conceptId(c.label)
    const prev = shelfById.get(id)
    if (prev) prev.memberIds.push(...c.memberIds)
    else {
      const shelf = { id, label: existing ? existing.label : c.label, memberIds: c.memberIds }
      shelfById.set(id, shelf)
      shelves.push(shelf)
    }
  }

  // Other's identity is fixed up front so the shelf itself can never become a member.
  const existingOther = hubByLabel.get(norm(OTHER_LABEL))
  const otherId = shelfById.has(conceptId(OTHER_LABEL))
    ? null // a named shelf claimed the slug (a hub literally labeled Other came back) — no separate Other
    : existingOther?.id || conceptId(OTHER_LABEL)

  // Membership: first assignment wins; shelves are never members.
  const assign = new Map() // conceptId -> shelfId
  for (const s of shelves)
    for (const m of s.memberIds) {
      if (shelfById.has(m) || m === otherId) continue
      if (!assign.has(m)) assign.set(m, s.id)
    }

  // Existing taxonomy edges by source, for the churn rule + supersession sweeps.
  const edgesFrom = new Map()
  for (const e of edges || []) {
    if (e?.origin !== 'taxonomy' || !e.source) continue
    if (!edgesFrom.has(e.source)) edgesFrom.set(e.source, [])
    edgesFrom.get(e.source).push(e)
  }

  // Unassigned concepts: keep a stable assignment to a surviving shelf; otherwise → Other.
  const toOther = []
  for (const c of all) {
    if (shelfById.has(c.id) || c.id === otherId || assign.has(c.id)) continue
    const stable = (edgesFrom.get(c.id) || []).find((e) => shelfById.has(e.target))
    if (stable) assign.set(c.id, stable.target)
    else toOther.push(c.id)
  }

  // Other materializes only with members; an existing Other hub stays a shelf regardless
  // (demoting-then-refiling an empty shelf would be pure churn).
  if (otherId && (toOther.length || existingOther)) {
    const other = { id: otherId, label: existingOther ? existingOther.label : OTHER_LABEL, memberIds: toOther }
    shelfById.set(otherId, other)
    shelves.push(other)
    for (const id of toOther) assign.set(id, otherId)
  }

  // Edge ops: each member ends with exactly one taxonomy edge — to its shelf. Adds and
  // removals are kept separate so apply can sequence them crash-safely.
  const add = []
  const removeIds = new Set()
  for (const [m, shelfId] of assign) {
    const existing = edgesFrom.get(m) || []
    if (!existing.some((e) => e.target === shelfId))
      add.push({ source: m, target: shelfId, label: shelfById.get(shelfId).label })
    for (const e of existing) if (e.target !== shelfId) removeIds.add(e.id)
  }
  // A shelf is a top-tier node — sweep any stray taxonomy edge that files a shelf under
  // something else (e.g. a satellite promoted to a category keeps no parent).
  for (const s of shelves) for (const e of edgesFrom.get(s.id) || []) removeIds.add(e.id)

  const demote = hubs.filter((h) => !shelfById.has(h.id)).map((h) => h.id)

  return {
    shelves: shelves.map(({ id, label }) => ({ id, label })),
    edges: { add, removeIds: [...removeIds] },
    demote,
    filed: assign.size,
  }
}

// --- apply (store-backed) ---

// Write order is the crash-safety: (1) shelf nodes, (2) new taxonomy edges, (3) superseded
// edge removals, (4) demotions — chosen so a throw at ANY point leaves a WORKING superset
// of the old graph: every node still exists, every previously-filed satellite still has an
// edge to a node that is still a hub (old edges and old hub flags are only retired AFTER
// the replacements are fully in place). A re-run from the superset converges to the plan.
export async function applyPlan(plan) {
  const now = new Date().toISOString()

  // 1. shelf nodes — mint new ones, promote a same-slug satellite, leave an existing hub
  //    untouched (reuse never renames; only a missing summary gets the shelf line).
  for (const s of plan.shelves) {
    const existing = await store.get('graphNodes', s.id)
    if (!existing) {
      await store.put('graphNodes', s.id, {
        id: s.id,
        kind: 'concept',
        label: s.label,
        domain: null,
        tags: [],
        summary: shelfSummary(s.label),
        sourcePmids: [],
        isHub: true,
        text: [s.label, shelfSummary(s.label)].join(' '),
        addedAt: now,
        updatedAt: now,
      })
    } else if (!existing.isHub || !existing.summary) {
      await store.put('graphNodes', s.id, {
        ...existing,
        isHub: true,
        summary: existing.summary || shelfSummary(existing.label || s.label),
        updatedAt: now,
      })
    }
  }

  // 2. new taxonomy edges (same shape linkToHub writes)
  for (const e of plan.edges.add) {
    const id = edgeId(e.source, e.target)
    const existing = await store.get('graphEdges', id)
    if (existing?.status === 'confirmed') continue
    await store.put('graphEdges', id, {
      id,
      source: e.source,
      target: e.target,
      status: 'confirmed',
      origin: 'taxonomy',
      rationale: e.label ? `part of “${e.label}”` : 'part of a broader topic',
      ts: existing?.ts || now,
      confirmedAt: now,
    })
  }

  // 3. retire superseded edges, then 4. demote hubs that are no longer categories
  for (const id of plan.edges.removeIds) await store.delete('graphEdges', id)
  for (const id of plan.demote) {
    const n = await store.get('graphNodes', id)
    if (n?.isHub) await store.put('graphNodes', id, { ...n, isHub: false, updatedAt: now })
  }
}

// --- the entry point ---

// (Re)organize the whole library into at most 10 shelves. Free no-op when it's already
// organized. A model failure (network/parse/refusal) is a clean no-op — nothing written.
// Returns { ok, categories, filed, skipped? } or { ok:false, error }.
export async function categorizeLibrary() {
  const { nodes, edges } = await loadGraph()
  const concepts = nodes.filter((n) => n.kind === 'concept')
  if (isCategorized(concepts, edges))
    return { ok: true, skipped: true, categories: concepts.filter((c) => c.isHub).length, filed: 0 }

  let raw
  try {
    raw = await proposeCategories({
      concepts: concepts.map((c) => ({ id: c.id, label: c.label, tags: c.tags })),
      hubLabels: concepts.filter((c) => c.isHub).map((c) => c.label),
    })
  } catch (err) {
    return { ok: false, error: err?.message || 'categorization failed' }
  }

  const plan = planCategorization(raw, concepts, edges)
  if (!plan.shelves.length) return { ok: false, error: 'the model returned no usable categories' }
  await applyPlan(plan) // ordered so a mid-apply crash leaves a working superset (see applyPlan)
  return { ok: true, categories: plan.shelves.length, filed: plan.filed }
}

// The background trigger: cheap graph read, then categorize only when the condition says
// so. Never throws — the save path fires this without awaiting and must never be broken.
export async function maybeReorganize() {
  try {
    const { nodes, edges } = await loadGraph()
    const concepts = nodes.filter((n) => n.kind === 'concept')
    if (!shouldReorganize(concepts, edges)) return null
    return await categorizeLibrary()
  } catch {
    return null
  }
}

// --- deposit-time helpers (the shelf set is FIXED at deposit; only this module changes it) ---

// The shelf whose label matches, case/space-insensitively — or null (→ the caller files to
// Other). Pure; this is the whole named-vs-missing decision at deposit time.
export function resolveCategory(label, hubs) {
  const n = norm(label)
  if (!n) return null
  return (hubs || []).find((h) => norm(h.label) === n) || null
}

// Ensure the Other shelf exists (reusing any hub already labeled Other, whatever its id)
// and return its node. Deposits use this when the model names a category that doesn't exist.
export async function ensureOtherCategory(hubs) {
  const existing = resolveCategory(OTHER_LABEL, hubs)
  if (existing) return existing
  const id = conceptId(OTHER_LABEL)
  const node = await store.get('graphNodes', id)
  if (node) {
    if (node.isHub) return node
    const promoted = { ...node, isHub: true, summary: node.summary || shelfSummary(OTHER_LABEL), updatedAt: new Date().toISOString() }
    await store.put('graphNodes', id, promoted)
    return promoted
  }
  const now = new Date().toISOString()
  const fresh = {
    id,
    kind: 'concept',
    label: OTHER_LABEL,
    domain: null,
    tags: [],
    summary: shelfSummary(OTHER_LABEL),
    sourcePmids: [],
    isHub: true,
    text: [OTHER_LABEL, shelfSummary(OTHER_LABEL)].join(' '),
    addedAt: now,
    updatedAt: now,
  }
  await store.put('graphNodes', id, fresh)
  return fresh
}

// Attach a paper directly to an existing node BY ID (upsertConcept can't — it re-slugs the
// name, which would duplicate a migration-id shelf). Used when a paper's own topic IS one
// of the shelves.
export async function addSourceToNode(nodeId, pmid) {
  const node = await store.get('graphNodes', nodeId)
  if (!node) return null
  const sourcePmids = Array.from(new Set([...(node.sourcePmids || []), String(pmid)]))
  const updated = { ...node, sourcePmids, updatedAt: new Date().toISOString() }
  await store.put('graphNodes', nodeId, updated)
  return updated
}
