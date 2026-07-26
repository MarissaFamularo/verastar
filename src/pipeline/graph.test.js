// graph.test.js — the pure graph logic (ids + structural noticing). The store-backed
// functions need IndexedDB and are exercised live in the browser; here we lock the parts
// that must never regress: undirected edge ids, anchor id stability, and the structural
// suggester never fabricating a duplicate or overriding a confirmed link.

import { describe, it, expect } from 'vitest'
import {
  anchorId,
  conceptId,
  edgeId,
  structuralSuggestions,
  coreAnchorPhrase,
  anchorMatch,
  significantTokens,
  trellisNodeId,
  trellisAnchorNodes,
} from './graph.js'

describe('ids', () => {
  it('anchor ids are kind-prefixed and case-normalized', () => {
    expect(anchorId('northStar', 'CLTI Outcomes')).toBe('ns:clti outcomes')
    expect(anchorId('project', 'Limb Preservation Program')).toBe('proj:limb preservation program')
  })

  it('edge ids are undirected — (a,b) and (b,a) collapse', () => {
    expect(edgeId('concept:clti-management', 'ns:clti outcomes')).toBe(
      edgeId('ns:clti outcomes', 'concept:clti-management'),
    )
  })

  it('concept ids are slugged from the name (re-use collapses to one node)', () => {
    expect(conceptId('CLTI Management')).toBe('concept:clti-management')
    expect(conceptId('  CLTI  Management  ')).toBe('concept:clti-management')
  })
})

describe('structuralSuggestions', () => {
  const anchor = (label, kind = 'northStar') => ({ id: anchorId(kind, label), kind, label, text: label })
  // content nodes are concepts; `text` is what the noticer scans (label + tags + summary)
  const concept = (name, text = name) => ({ id: conceptId(name), kind: 'concept', label: name, text })

  it('proposes a concept→anchor edge when the concept text names the anchor', () => {
    const nodes = [anchor('carotid revascularization'), concept('Carotid Management', 'Long-term carotid revascularization outcomes')]
    const out = structuralSuggestions(nodes, [])
    const ids = out.map((o) => o.source + '|' + o.target)
    expect(out.some((o) => o.target === anchorId('northStar', 'carotid revascularization'))).toBe(true)
    expect(out.every((o) => o.origin === 'structural')).toBe(true)
    // no self-links, no anchor↔anchor spam
    expect(ids.every((s) => s.includes('concept:'))).toBe(true)
  })

  it('links two concepts that share an anchor (the serendipitous one)', () => {
    const a = anchor('CLTI outcomes')
    const c1 = concept('CLTI Management', 'A trial on CLTI outcomes')
    const c2 = concept('Wound Care', 'Registry of CLTI outcomes')
    const out = structuralSuggestions([a, c1, c2], [])
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(c1.id, c2.id))).toBe(true)
  })

  it('never re-proposes an edge that already exists', () => {
    const a = anchor('CLTI outcomes')
    const c1 = concept('CLTI Management', 'A trial on CLTI outcomes')
    const existing = [{ id: edgeId(c1.id, a.id), source: c1.id, target: a.id, status: 'confirmed' }]
    const out = structuralSuggestions([a, c1], existing)
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(c1.id, a.id))).toBe(false)
  })

  it('does not duplicate within a single pass', () => {
    const a = anchor('CLTI outcomes')
    const c1 = concept('CLTI Management', 'CLTI outcomes and more CLTI outcomes')
    const out = structuralSuggestions([a, c1], [])
    const key = edgeId(c1.id, a.id)
    expect(out.filter((o) => edgeId(o.source, o.target) === key).length).toBe(1)
  })

  it('never re-proposes a satellite↔hub pair already joined by a taxonomy edge', () => {
    // The two-tier skeleton links a specific concept to its broad hub with a CONFIRMED taxonomy
    // edge. Both mention the same anchor, which would otherwise trigger a dashed serendipity edge —
    // the existing-edge guard must suppress it so the skeleton line isn't shadowed by a "maybe".
    const a = anchor('carotid revascularization')
    const sat = concept('Transcarotid Outcomes', 'carotid revascularization stroke risk')
    const hub = { ...concept('Carotid Revascularization', 'carotid revascularization'), isHub: true }
    const taxonomy = [{ id: edgeId(sat.id, hub.id), source: sat.id, target: hub.id, status: 'confirmed', origin: 'taxonomy' }]
    const out = structuralSuggestions([a, sat, hub], taxonomy)
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(sat.id, hub.id))).toBe(false)
  })

  it('links two concepts that share a topic tag (cross-domain serendipity)', () => {
    const tagged = (name, tags) => ({ ...concept(name, 'x'), tags })
    const c1 = tagged('CLTI Management', ['amputation-free survival', 'clti'])
    const c2 = tagged('Revascularization', ['amputation-free survival']) // shares one tag
    const c3 = tagged('Carotid', ['carotid stenting']) // shares nothing
    const out = structuralSuggestions([c1, c2, c3], [])
    const shared = out.find((o) => edgeId(o.source, o.target) === edgeId(c1.id, c2.id))
    expect(shared?.rationale).toContain('amputation-free survival')
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(c1.id, c3.id))).toBe(false)
  })

  it('skips over-common tags so the map does not over-connect', () => {
    // a tag shared by >5 concepts behaves like a domain — no pairwise edges
    const common = Array.from({ length: 7 }, (_, i) => ({ ...concept('C' + i, 'x'), tags: ['pad'] }))
    const out = structuralSuggestions(common, [])
    expect(out.length).toBe(0)
  })
})

describe('anchor core-phrase matching', () => {
  const anchor = (label, kind = 'project') => ({ id: anchorId(kind, label), kind, label, text: label })
  const concept = (name, text = name) => ({ id: conceptId(name), kind: 'concept', label: name, text })

  it('coreAnchorPhrase strips generic effort-words from the ends', () => {
    expect(coreAnchorPhrase('Carotid Revascularization Initiative')).toBe('carotid revascularization')
    expect(coreAnchorPhrase('COSMOS utilization study')).toBe('cosmos utilization')
    expect(coreAnchorPhrase('Limb Preservation Program')).toBe('limb preservation')
    expect(coreAnchorPhrase('Diabetic Foot')).toBe('diabetic foot') // nothing generic to strip
    expect(coreAnchorPhrase('Program')).toBe('program') // never strips down to nothing
  })

  it('an org-flavored project label still lands on its topic hub', () => {
    // The verbatim label "Carotid Revascularization Initiative" never appears in concept
    // text — the core phrase must carry the match.
    const proj = anchor('Carotid Revascularization Initiative')
    const hub = { ...concept('Carotid Revascularization', 'carotid revascularization cea cas tcar'), isHub: true }
    const out = structuralSuggestions([proj, hub], [])
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(hub.id, proj.id))).toBe(true)
  })

  it('anchors tie to the hub, not to every satellite under it', () => {
    const proj = anchor('Carotid Revascularization Initiative')
    const hub = { ...concept('Carotid Revascularization', 'carotid revascularization'), isHub: true }
    const sat = concept('TCAR Outcomes', 'carotid revascularization stroke risk')
    const taxonomy = [{ id: edgeId(sat.id, hub.id), source: sat.id, target: hub.id, status: 'confirmed', origin: 'taxonomy' }]
    const out = structuralSuggestions([proj, hub, sat], taxonomy)
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(hub.id, proj.id))).toBe(true)
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(sat.id, proj.id))).toBe(false)
  })
})

describe('anchorMatch (keyword auto-linking)', () => {
  const concept = (name, text = name, tags = []) => ({ id: conceptId(name), kind: 'concept', label: name, text, tags })

  it('links an abbreviated project title to its spelled-out concept', () => {
    // the whole point: the verbatim/core phrase never appears, the shared tokens do
    const m = anchorMatch('Pop Artery Aneurysm (COSMOS)', concept('Popliteal Artery Aneurysm', 'popliteal artery aneurysm repair outcomes'))
    expect(m).toBeTruthy()
    expect(m.score).toBeGreaterThanOrEqual(2)
    expect(m.tokens).toContain('artery')
    expect(m.tokens).toContain('aneurysm')
  })

  it('links a hyphenated project to concepts sharing its domain tokens', () => {
    expect(anchorMatch('Frailty-CLTI Study', concept('Frailty in CLTI', 'frailty predicts amputation in clti'))).toBeTruthy()
    // one shared domain token is not enough on a multi-token anchor
    expect(anchorMatch('Frailty-CLTI Study', concept('CLTI Revascularization', 'clti revascularization outcomes'))).toBeNull()
  })

  it('generic tokens alone never link', () => {
    // every token here is a stopword — no significant tokens, no match against anything
    expect(anchorMatch('Clinical Outcomes Study', concept('Wound Care', 'clinical outcomes study of wound care'))).toBeNull()
    expect(significantTokens('study clinical research outcomes patients').size).toBe(0)
  })

  it('requires 2 distinct hits, but a single-token anchor may match on its one token', () => {
    // "Aneurysm Surveillance" has 2 significant tokens — one shared is not a match
    expect(anchorMatch('Aneurysm Surveillance', concept('Aortic Aneurysm', 'aneurysm growth'))).toBeNull()
    // "Frailty Program" strips to the single token "frailty" — that one token IS the topic
    const m = anchorMatch('Frailty Program', concept('Frailty Index', 'frailty index validation'))
    expect(m).toBeTruthy()
    expect(m.score).toBe(1)
  })

  it('stems plural and derived forms onto one token', () => {
    expect(anchorMatch('Aortic Aneurysms Registry', concept('Aortic Aneurysm', 'aortic aneurysm repair'))).toBeTruthy()
    expect(anchorMatch('Stroke Risk Prediction', concept('Predictive Models for Stroke', 'predictive stroke tools'))).toBeTruthy()
  })

  it('matches against the concept tags, not just its text', () => {
    const c = concept('Limb Salvage', 'limb salvage strategies', ['popliteal', 'aneurysm'])
    expect(anchorMatch('Popliteal Aneurysm Repair', c)).toBeTruthy()
  })
})

describe('structuralSuggestions keyword pass', () => {
  const projAnchor = (label, desc = '') => ({ id: anchorId('project', label), kind: 'project', label, desc, text: label })
  const concept = (name, text = name) => ({ id: conceptId(name), kind: 'concept', label: name, text, tags: [] })

  it('proposes a keyword edge with a rationale naming the shared tokens', () => {
    const proj = projAnchor('Pop Artery Aneurysm (COSMOS)')
    const c = concept('Popliteal Artery Aneurysm', 'popliteal artery aneurysm anticoagulation')
    const out = structuralSuggestions([proj, c], [])
    const e = out.find((o) => edgeId(o.source, o.target) === edgeId(c.id, proj.id))
    expect(e).toBeTruthy()
    expect(e.origin).toBe('keyword')
    expect(e.rationale).toContain('artery')
    expect(e.rationale).toContain('aneurysm')
    expect(e.rationale).toContain('Pop Artery Aneurysm (COSMOS)')
  })

  it('matches through the anchor description, not only the label', () => {
    const proj = projAnchor('COSMOS Chapter Two', 'Does anticoagulation reduce thrombosis after popliteal aneurysm repair?')
    const c = concept('Popliteal Aneurysm Anticoagulation', 'anticoagulation strategy after popliteal aneurysm repair')
    const out = structuralSuggestions([proj, c], [])
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(c.id, proj.id))).toBe(true)
  })

  it('caps keyword edges per anchor at 12, highest scores first', () => {
    const proj = projAnchor('Popliteal Artery Aneurysm Anticoagulation')
    // 14 two-hit candidates + 1 richer candidate that must survive the cap
    const weak = Array.from({ length: 14 }, (_, i) => concept(`Weak ${i}`, 'popliteal artery disease'))
    // word order breaks the verbatim mention path — this one can only arrive via keywords
    const strong = concept('Strong', 'anticoagulation outcomes in popliteal artery aneurysm')
    const out = structuralSuggestions([proj, strong, ...weak], [])
    const keyword = out.filter((o) => o.origin === 'keyword' && o.target === proj.id)
    expect(keyword.length).toBe(12)
    expect(keyword.some((o) => o.source === strong.id)).toBe(true)
  })

  it('keyword ties do not seed pairwise shared-anchor serendipity', () => {
    // two concepts keyword-tied to the same project must NOT auto-pair — with the 12-cap a
    // broad project would otherwise mint 66 pair edges in one pass
    const proj = projAnchor('Popliteal Aneurysm Anticoagulation')
    const c1 = concept('C One', 'popliteal aneurysm growth')
    const c2 = concept('C Two', 'popliteal aneurysm thrombosis')
    const out = structuralSuggestions([proj, c1, c2], [])
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(c1.id, c2.id))).toBe(false)
    // and a persisted keyword edge stays out of the tie set on the next pass, too
    const persisted = out.map((o) => ({ ...o, id: edgeId(o.source, o.target), status: 'confirmed' }))
    const again = structuralSuggestions([proj, c1, c2], persisted)
    expect(again.some((o) => edgeId(o.source, o.target) === edgeId(c1.id, c2.id))).toBe(false)
  })

  it('never keyword-links a satellite (hub-only, like mentions)', () => {
    const proj = projAnchor('Popliteal Aneurysm Anticoagulation')
    const hub = { ...concept('Popliteal Aneurysm', 'popliteal aneurysm'), isHub: true }
    const sat = concept('Popliteal Aneurysm Thrombolysis', 'popliteal aneurysm thrombolysis')
    const taxonomy = [{ id: edgeId(sat.id, hub.id), source: sat.id, target: hub.id, status: 'confirmed', origin: 'taxonomy' }]
    const out = structuralSuggestions([proj, hub, sat], taxonomy)
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(hub.id, proj.id))).toBe(true)
    expect(out.some((o) => edgeId(o.source, o.target) === edgeId(sat.id, proj.id))).toBe(false)
  })
})

describe('PaperTrellis project stars', () => {
  const pt = (id, title, description = '', extra = {}) => ({ id, title, description, ...extra })

  it('node ids are stable — derived from the PT row id, not the title', () => {
    expect(trellisNodeId('abc-123')).toBe('proj:pt-abc-123')
    const a = trellisAnchorNodes([], [pt('abc-123', 'Pop Artery Aneurysm (COSMOS)')])
    const b = trellisAnchorNodes(a.nodes, [pt('abc-123', 'Renamed Title')])
    expect(a.nodes[0].id).toBe(b.nodes[0].id)
    expect(b.nodes[0].label).toBe('Renamed Title') // renames flow through, same star
  })

  it('builds project-shaped nodes carrying source, ptId, and a truncated desc', () => {
    const long = 'x'.repeat(300)
    const { nodes } = trellisAnchorNodes([], [pt('u1', 'Frailty-CLTI Study', long)])
    expect(nodes[0]).toMatchObject({ kind: 'project', label: 'Frailty-CLTI Study', source: 'papertrellis', ptId: 'u1' })
    expect(nodes[0].desc.length).toBe(200)
    expect(nodes[0].text).toContain('Frailty-CLTI Study')
  })

  it('preserves addedAt across re-syncs', () => {
    const first = trellisAnchorNodes([], [pt('u1', 'Frailty-CLTI Study')])
    const again = trellisAnchorNodes(first.nodes, [pt('u1', 'Frailty-CLTI Study')])
    expect(again.nodes[0].addedAt).toBe(first.nodes[0].addedAt)
  })

  it('flags un-starred PT nodes as stale, never the manual project stars', () => {
    const manual = { id: anchorId('project', 'Limb Preservation Program'), kind: 'project', label: 'Limb Preservation Program' }
    const kept = { id: trellisNodeId('u1'), kind: 'project', source: 'papertrellis', ptId: 'u1', addedAt: 't' }
    const gone = { id: trellisNodeId('u2'), kind: 'project', source: 'papertrellis', ptId: 'u2', addedAt: 't' }
    const { nodes, staleIds } = trellisAnchorNodes([manual, kept, gone], [pt('u1', 'Kept Project')])
    expect(staleIds).toEqual([trellisNodeId('u2')])
    expect(nodes.map((n) => n.id)).toEqual([trellisNodeId('u1')])
  })

  it('empty starred set (signed out / never synced) builds nothing and sweeps nothing new', () => {
    expect(trellisAnchorNodes([], [])).toEqual({ nodes: [], staleIds: [] })
  })
})
