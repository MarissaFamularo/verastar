// pipeline/deposit.js — the shared "file a paper into the graph" logic, used by BOTH the deposit
// flow (SpineCheck "Save to KB") and the "re-file my KB" action. Keeping it in one place means the
// two paths can't drift.
//
// The model (see graph.js / concepts.js): categories are the clinician's north stars + projects; a
// paper files under a finer CONCEPT beneath a category, or — when its topic IS a north star —
// directly under that anchor (no duplicate concept). analyzePaper (Claude) decides; everything else
// is deterministic store work.

import { getProfile, store } from '../lib/store.js'
import { analyzePaper, synthesizeConcept } from './concepts.js'
import {
  loadGraph,
  loadConcepts,
  syncAnchors,
  anchorId,
  upsertConcept,
  attachPaperToAnchor,
  setConceptSummary,
  proposeEdge,
  removeNode,
} from './graph.js'

const norm = (s) => (s || '').trim().toLowerCase()

// File one already-saved paper: analyze → attach under an anchor or a sub-concept → patch the
// paper record (category + conceptId + tags). Does NOT synthesize the summary (do that once per
// group via synthesizeGroup, so a batch re-file doesn't re-synthesize per paper). `ctx.anchors`
// lets a batch pass the synced anchors once. Returns { groupId, fileUnderAnchor } or null.
export async function filePaper(paper, ctx = {}) {
  const anchors = ctx.anchors || (await syncAnchors(await getProfile()))
  const labelById = new Map(anchors.map((a) => [a.id, a.label]))
  const existing = await loadConcepts()

  const { category, concept, tags } = await analyzePaper({
    paper: { title: paper.title, finding: paper.finding, relevance: paper.relevance, text: paper.fullText },
    categories: anchors.map((a) => ({ label: a.label, kind: a.kind })),
    concepts: existing.map((c) => ({ name: c.label, category: labelById.get(c.category) || '' })),
  })

  const categoryAnchorId = category ? anchorId(category.kind, category.label) : null
  const fileUnderAnchor = category && norm(concept) === norm(category.label) && !!categoryAnchorId

  let groupId
  let patch
  if (fileUnderAnchor) {
    await attachPaperToAnchor(categoryAnchorId, paper.id)
    groupId = categoryAnchorId
    patch = { category: categoryAnchorId, conceptId: null, tags }
  } else {
    const node = await upsertConcept({ name: concept, category: categoryAnchorId, tags, sourcePmids: [paper.id] })
    groupId = node.id
    patch = { category: categoryAnchorId, conceptId: node.id, tags }
    if (categoryAnchorId)
      await proposeEdge({
        source: node.id,
        target: categoryAnchorId,
        rationale: `under “${category.label}”`,
        origin: 'structural',
      })
  }

  const current = await store.get('papers', paper.id)
  if (!current) return null // un-saved while we were working
  await store.put('papers', paper.id, { ...current, ...patch })
  return { groupId, fileUnderAnchor }
}

// (Re)synthesize one grouping node's evidence summary from every saved paper filed under it.
export async function synthesizeGroup(groupId, { fileUnderAnchor = false } = {}) {
  const node = await store.get('graphNodes', groupId)
  if (!node) return
  const all = (await store.all('papers')) || []
  const members = all.filter((p) =>
    fileUnderAnchor
      ? (p.category === groupId && !p.conceptId) || (node.sourcePmids || []).includes(String(p.pmid))
      : p.conceptId === groupId || (node.sourcePmids || []).includes(String(p.pmid)),
  )
  const summary = await synthesizeConcept({
    concept: node,
    papers: members.map((p) => ({ title: p.title, finding: p.finding })),
  })
  if (summary) await setConceptSummary(groupId, summary)
}

// Re-file the WHOLE knowledge base under the current profile's categories. Clears the existing
// concept nodes (and their edges), resets each paper's filing, then re-classifies every saved
// paper and re-synthesizes each touched group once. Paid: one analyzePaper call per paper + one
// synthesizeConcept per group. `onProgress(done, total)` fires per paper. Returns a small summary.
export async function refileKB(onProgress) {
  const anchors = await syncAnchors(await getProfile())

  // clean slate for concepts; keep the anchors but clear what they'd accreted so they rebuild.
  const { nodes } = await loadGraph()
  for (const n of nodes.filter((n) => n.kind === 'concept')) await removeNode(n.id)
  for (const a of anchors) {
    const fresh = await store.get('graphNodes', a.id)
    if (fresh) await store.put('graphNodes', a.id, { ...fresh, sourcePmids: [], summary: '' })
  }

  const papers = (await store.all('papers')) || []
  for (const p of papers) await store.put('papers', p.id, { ...p, category: null, conceptId: null })

  const touched = new Map() // groupId -> fileUnderAnchor
  let done = 0
  for (const p of papers) {
    try {
      const fresh = await store.get('papers', p.id)
      const res = fresh && (await filePaper(fresh, { anchors }))
      if (res?.groupId) touched.set(res.groupId, res.fileUnderAnchor)
    } catch {
      // skip a paper that fails to analyze — the rest still re-file
    }
    onProgress?.(++done, papers.length)
  }

  for (const [groupId, fileUnderAnchor] of touched) {
    try {
      await synthesizeGroup(groupId, { fileUnderAnchor })
    } catch {
      // a failed summary leaves the group intact, just without fresh prose
    }
  }
  return { papers: papers.length, groups: touched.size }
}
