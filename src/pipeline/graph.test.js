// graph.test.js — the pure graph logic (ids + structural noticing). The store-backed
// functions need IndexedDB and are exercised live in the browser; here we lock the parts
// that must never regress: undirected edge ids, anchor id stability, and the structural
// suggester never fabricating a duplicate or overriding a confirmed link.

import { describe, it, expect } from 'vitest'
import { anchorId, conceptId, edgeId, structuralSuggestions } from './graph.js'

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
