// pipeline/deposit.js — the shared "file a paper into the graph" logic, used by BOTH the deposit
// flow (SpineCheck "Save to KB") and the "re-file my KB" action. Keeping it in one place means the
// two paths can't drift.
//
// The model (mirrors her real KG): every paper becomes a source under a topic-level CONCEPT node,
// classified into ONE broad DOMAIN (which colors it). Concepts link to each other and to project
// nodes via structural noticing. North stars are not graph nodes.

import { getProfile, store } from '../lib/store.js'
import { listDomains, removeDomain, userDomainKeys } from '../lib/domains.js'
import { analyzePaper, synthesizeConcept, proposeDomainMerges } from './concepts.js'
import { resolveCategory, ensureOtherCategory, addSourceToNode } from './categorize.js'
import {
  loadGraph,
  syncAnchors,
  upsertConcept,
  linkToHub,
  setConceptSummary,
  removeNode,
} from './graph.js'

// File one already-saved paper into the two-tier concept graph: analyze → upsert its SPECIFIC
// concept (the satellite the paper is a source of) → link it under its CATEGORY shelf with a
// confirmed taxonomy edge (the map's skeleton) → patch the paper record (domain + conceptId +
// tags). The category set is FIXED at deposit time: the classifier must name one of the
// existing shelves, an unresolvable name files to "Other", and a deposit never mints a hub —
// shelves change only through categorizeLibrary(). Before the first organization (no hubs yet)
// the satellite simply floats; enough floaters trip the reorganize trigger, which mints the
// initial shelves. Does NOT synthesize the summary (do that once per concept via
// synthesizeGroup so a batch re-file doesn't re-synthesize per paper). Returns { groupId } or null.
export async function filePaper(paper) {
  const { nodes, edges } = await loadGraph()
  const existing = nodes.filter((n) => n.kind === 'concept')
  const hubs = existing.filter((c) => c.isHub)
  // The reader's projects are banned as topic names — the Relevance line names them
  // ("…informs your Limb Preservation Program") and the model would otherwise mint a
  // topic that duplicates the map's yellow project star.
  const profile = await getProfile()
  const { concept, hub, domain, tags } = await analyzePaper({
    paper: { title: paper.title, finding: paper.finding, relevance: paper.relevance, text: paper.fullText },
    concepts: existing.map((c) => ({ name: c.label, domain: c.domain, isHub: c.isHub })),
    projects: profile?.projects || [],
    categories: hubs.map((h) => h.label),
  })

  const patchPaper = async (groupId) => {
    const current = await store.get('papers', paper.id)
    if (!current) return null // un-saved while we were working
    await store.put('papers', paper.id, { ...current, domain, tags, conceptId: groupId })
    return { groupId }
  }

  // Paper's own topic IS one of the shelves → file it directly on the shelf node (by ID —
  // re-slugging the name via upsertConcept would duplicate a migration-id shelf).
  const shelfForConcept = resolveCategory(concept, hubs)
  if (shelfForConcept) {
    await addSourceToNode(shelfForConcept.id, paper.id)
    return patchPaper(shelfForConcept.id)
  }

  const node = await upsertConcept({ name: concept, domain, tags, sourcePmids: [paper.id] })
  if (hubs.length) {
    // A satellite that's already shelved keeps its shelf (stable assignments don't churn);
    // otherwise it goes where the classifier said — or to Other when that shelf doesn't exist.
    const hubIds = new Set(hubs.map((h) => h.id))
    const alreadyFiled = edges.some(
      (e) => e?.origin === 'taxonomy' && e.source === node.id && hubIds.has(e.target),
    )
    if (!alreadyFiled) {
      const shelf = resolveCategory(hub, hubs) || (await ensureOtherCategory(hubs))
      await linkToHub(node.id, shelf.id, shelf.label)
    }
  }
  return patchPaper(node.id)
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

// Which fields the tidy pass may absorb away. Pure. A field is a candidate only when it is
// UNDER-populated but not EMPTY, and not one the user owns:
//   - the user's own fields (added or renamed in Settings) are her taxonomy, not Claude's;
//   - a field with zero papers was created deliberately — filing is what mints a field, so a
//     count of 0 means a human typed it (typically ahead of the papers, to steer filing).
//     That also covers fields added before `source` was recorded.
export function mergeCandidates(domains, counts, pinned = new Set()) {
  return new Set(
    (domains || [])
      .filter((d) => {
        const n = counts.get(d.key) || 0
        return !pinned.has(d.key) && n > 0 && n < SPARSE_MIN
      })
      .map((d) => d.key),
  )
}

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
// SPARSE field that the user does NOT own; `into` is a real, different field that is NOT itself
// being merged away (no chains); and each field is merged at most once. Claude proposes; this
// disposes. A field the user typed or renamed in Settings is theirs — the tidy pass may absorb
// other fields INTO it, but must never delete or rename it, however sparse it looks.
export function pickMerges(proposed, { keys, sparse, protectedKeys = new Set() }) {
  const froms = new Set((proposed || []).map((m) => m?.from))
  const merged = new Set()
  const out = []
  for (const m of proposed || []) {
    const { from, into } = m || {}
    if (!from || !into || from === into) continue
    if (!keys.has(from) || !keys.has(into)) continue
    if (!sparse.has(from)) continue
    if (protectedKeys.has(from)) continue
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
  // The user's own fields are never merge candidates — absorbing one would undo her edit.
  const pinned = userDomainKeys()
  const sparse = mergeCandidates(domains, counts, pinned)
  if (!sparse.size) return []

  const fields = domains.map((d) => ({
    key: d.key,
    label: d.label,
    count: counts.get(d.key) || 0,
    pinned: pinned.has(d.key),
    papers: sparse.has(d.key)
      ? papers.filter((p) => p.domain === d.key).map((p) => p.title).filter(Boolean).slice(0, 6)
      : [],
  }))
  const proposed = await proposeDomainMerges({ fields })
  const merges = pickMerges(proposed, {
    keys: new Set(domains.map((d) => d.key)),
    sparse,
    protectedKeys: pinned,
  })

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

// Re-file the WHOLE knowledge base: clear the existing SATELLITE concept nodes (+ their edges),
// reset each paper's filing, then re-classify every saved paper into a concept and re-synthesize
// each touched concept once. The CATEGORY shelves (hub nodes) deliberately survive — the shelf
// set changes only through categorizeLibrary(), so a re-file redistributes papers into the
// categories the user already has rather than destroying them. The DOMAIN taxonomy is likewise
// NOT cleared — re-filing runs through filePaper → analyzePaper, which reads the live domain
// list, so a re-file is exactly the action that pulls papers into fields the user added by hand
// since they were first saved. Paid: one analyzePaper call per paper + one synthesizeConcept per
// concept. `onProgress(done, total)` fires per paper. Returns a small summary.
export async function refileKB(onProgress) {
  await syncAnchors(await getProfile()) // ensure project nodes exist; sweep any legacy north stars

  const { nodes } = await loadGraph()
  const concepts = nodes.filter((n) => n.kind === 'concept')
  for (const n of concepts.filter((n) => !n.isHub)) await removeNode(n.id)
  // Shelves stay, but their direct-source lists reset — stale pmid claims would otherwise
  // re-capture papers (buildKB's sourcePmids fallback) before the re-file reaches them.
  for (const h of concepts.filter((n) => n.isHub)) {
    if (h.sourcePmids?.length)
      await store.put('graphNodes', h.id, { ...h, sourcePmids: [], updatedAt: new Date().toISOString() })
  }

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
