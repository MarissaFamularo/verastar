// pipeline/deposit.js — the shared "file a paper into the graph" logic, used by BOTH the deposit
// flow (SpineCheck "Save to KB") and the "re-file my KB" action. Keeping it in one place means the
// two paths can't drift.
//
// The model (mirrors her real KG): every paper becomes a source under a topic-level CONCEPT node,
// classified into ONE broad DOMAIN (which colors it). Concepts link to each other and to project
// nodes via structural noticing. North stars are not graph nodes.

import { getProfile, store } from '../lib/store.js'
import { listDomains, removeDomain } from '../lib/domains.js'
import { analyzePaper, synthesizeConcept, proposeDomainMerges } from './concepts.js'
import {
  loadGraph,
  loadConcepts,
  syncAnchors,
  upsertConcept,
  linkToHub,
  setConceptSummary,
  removeNode,
} from './graph.js'

// File one already-saved paper into the two-tier concept graph: analyze → upsert its SPECIFIC
// concept (the satellite the paper is a source of) → upsert the BROAD hub it belongs under →
// link satellite→hub with a confirmed taxonomy edge (the map's skeleton) → patch the paper record
// (domain + conceptId + tags). Does NOT synthesize the summary (do that once per concept via
// synthesizeGroup so a batch re-file doesn't re-synthesize per paper). Returns { groupId } or null.
export async function filePaper(paper) {
  const existing = await loadConcepts()
  // The reader's projects are banned as topic names — the Relevance line names them
  // ("…informs your Limb Preservation Program") and the model would otherwise mint a
  // topic that duplicates the map's yellow project star.
  const profile = await getProfile()
  const { concept, hub, domain, tags } = await analyzePaper({
    paper: { title: paper.title, finding: paper.finding, relevance: paper.relevance, text: paper.fullText },
    concepts: existing.map((c) => ({ name: c.label, domain: c.domain, isHub: c.isHub })),
    projects: profile?.projects || [],
  })
  const node = await upsertConcept({ name: concept, domain, tags, sourcePmids: [paper.id] })
  // The broad hub is a grouping node (no papers of its own, same domain color); the satellite
  // hangs off it. When concept === hub the paper's topic already IS broad — no separate hub node.
  if (hub && hub !== concept) {
    const hubNode = await upsertConcept({ name: hub, domain, isHub: true })
    await linkToHub(node.id, hubNode.id, hubNode.label)
  }

  const current = await store.get('papers', paper.id)
  if (!current) return null // un-saved while we were working
  await store.put('papers', paper.id, { ...current, domain, tags, conceptId: node.id })
  return { groupId: node.id }
}

// (Re)synthesize one concept's evidence summary from every saved paper filed under it.
export async function synthesizeGroup(groupId) {
  const node = await store.get('graphNodes', groupId)
  if (!node) return
  const all = (await store.all('papers')) || []
  const members = all.filter(
    (p) => p.conceptId === groupId || (node.sourcePmids || []).includes(String(p.pmid)),
  )
  const summary = await synthesizeConcept({
    concept: node,
    papers: members.map((p) => ({ title: p.title, finding: p.finding })),
  })
  if (summary) await setConceptSummary(groupId, summary)
}

// --- taxonomy tidying: keep the field set a handful, not a long tail of micro-fields ---

// A field is SPARSE below this many papers. Tidying only runs once the taxonomy has grown
// past a handful — a young library's brand-new fields are left alone, so the classifier's
// freedom to mint distinct disciplines (the anti-collapse rule) isn't undone here.
export const SPARSE_MIN = 3
export const TIDY_MIN_FIELDS = 4

// Papers per domain key. Pure.
export function domainCounts(papers) {
  const counts = new Map()
  for (const p of papers || []) {
    if (!p?.domain) continue
    counts.set(p.domain, (counts.get(p.domain) || 0) + 1)
  }
  return counts
}

// Sanitize Claude's proposed merges. Pure. A merge survives only when: `from` is a real,
// SPARSE field; `into` is a real, different field that is NOT itself being merged away
// (no chains); and each field is merged at most once. Claude proposes; this disposes.
export function pickMerges(proposed, { keys, sparse }) {
  const froms = new Set((proposed || []).map((m) => m?.from))
  const merged = new Set()
  const out = []
  for (const m of proposed || []) {
    const { from, into } = m || {}
    if (!from || !into || from === into) continue
    if (!keys.has(from) || !keys.has(into)) continue
    if (!sparse.has(from)) continue
    if (froms.has(into)) continue
    if (merged.has(from)) continue
    merged.add(from)
    out.push({ from, into })
  }
  return out
}

// Consider consolidating the field taxonomy. Self-gating and usually free: returns []
// without an API call unless the taxonomy is past a handful AND has sparse fields. When it
// does run, one cheap structured call proposes merges; applying one re-points every affected
// paper + concept node and deletes the absorbed field (its color returns to the palette).
export async function consolidateDomains() {
  const domains = listDomains()
  if (domains.length < TIDY_MIN_FIELDS) return []
  const papers = (await store.all('papers')) || []
  const counts = domainCounts(papers)
  const sparse = new Set(domains.filter((d) => (counts.get(d.key) || 0) < SPARSE_MIN).map((d) => d.key))
  if (!sparse.size) return []

  const fields = domains.map((d) => ({
    key: d.key,
    label: d.label,
    count: counts.get(d.key) || 0,
    papers: sparse.has(d.key)
      ? papers.filter((p) => p.domain === d.key).map((p) => p.title).filter(Boolean).slice(0, 6)
      : [],
  }))
  const proposed = await proposeDomainMerges({ fields })
  const merges = pickMerges(proposed, { keys: new Set(domains.map((d) => d.key)), sparse })

  const nodes = (await store.all('graphNodes')) || []
  for (const { from, into } of merges) {
    for (const p of papers.filter((p) => p.domain === from)) {
      const cur = await store.get('papers', p.id)
      if (cur) await store.put('papers', p.id, { ...cur, domain: into })
    }
    for (const n of nodes.filter((n) => n.kind === 'concept' && n.domain === from)) {
      await store.put('graphNodes', n.id, { ...n, domain: into })
    }
    await removeDomain(from)
  }
  return merges
}

// Re-file the WHOLE knowledge base: clear the existing concept nodes (+ their edges), reset each
// paper's filing, then re-classify every saved paper into a concept and re-synthesize each touched
// concept once. Paid: one analyzePaper call per paper + one synthesizeConcept per concept.
// `onProgress(done, total)` fires per paper. Returns a small summary.
export async function refileKB(onProgress) {
  await syncAnchors(await getProfile()) // ensure project nodes exist; sweep any legacy north stars

  const { nodes } = await loadGraph()
  for (const n of nodes.filter((n) => n.kind === 'concept')) await removeNode(n.id)

  const papers = (await store.all('papers')) || []
  for (const p of papers) {
    const { category, ...rest } = p // drop the transitional `category` field if present
    await store.put('papers', p.id, { ...rest, domain: null, conceptId: null })
  }

  const touched = new Set()
  let done = 0
  for (const p of papers) {
    try {
      const fresh = await store.get('papers', p.id)
      const res = fresh && (await filePaper(fresh))
      if (res?.groupId) touched.add(res.groupId)
    } catch {
      // skip a paper that fails to analyze — the rest still re-file
    }
    onProgress?.(++done, papers.length)
  }

  for (const groupId of touched) {
    try {
      await synthesizeGroup(groupId)
    } catch {
      // a failed summary leaves the concept intact, just without fresh prose
    }
  }

  let merges = []
  try {
    merges = await consolidateDomains()
  } catch {
    // a failed tidy leaves the taxonomy as classified — never blocks the re-file
  }
  return { papers: papers.length, groups: touched.size, merged: merges.length }
}
