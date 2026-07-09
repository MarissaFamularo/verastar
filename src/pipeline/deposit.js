// pipeline/deposit.js — the shared "file a paper into the graph" logic, used by BOTH the deposit
// flow (SpineCheck "Save to KB") and the "re-file my KB" action. Keeping it in one place means the
// two paths can't drift.
//
// The model (mirrors her real KG): every paper becomes a source under a topic-level CONCEPT node,
// classified into ONE broad DOMAIN (which colors it). Concepts link to each other and to project
// nodes via structural noticing. North stars are not graph nodes.

import { getProfile, store } from '../lib/store.js'
import { analyzePaper, synthesizeConcept } from './concepts.js'
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
  const { concept, hub, domain, tags } = await analyzePaper({
    paper: { title: paper.title, finding: paper.finding, relevance: paper.relevance, text: paper.fullText },
    concepts: existing.map((c) => ({ name: c.label, domain: c.domain, isHub: c.isHub })),
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
  return { papers: papers.length, groups: touched.size }
}
