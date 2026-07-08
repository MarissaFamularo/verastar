// kb.test.js — the pure KB search/filter. Locks the browse rules: concept-first grouping, search
// reaching title/summary/tags/notes across concept and papers, the domain filter, unfiled bucket.

import { describe, it, expect } from 'vitest'
import { buildKB } from './kb.js'

const concept = (id, over = {}) => ({
  id,
  kind: 'concept',
  label: over.label || id,
  domain: over.domain ?? 'vascular',
  summary: over.summary ?? '',
  tags: over.tags ?? [],
  sourcePmids: over.sourcePmids ?? [],
})
const paper = (id, over = {}) => ({
  id,
  pmid: over.pmid ?? id,
  title: over.title || id,
  finding: over.finding ?? '',
  notes: over.notes ?? '',
  tags: over.tags ?? [],
  domain: over.domain ?? null,
  conceptId: over.conceptId ?? null,
})

describe('buildKB grouping', () => {
  it('files a paper under its concept by conceptId', () => {
    const c = concept('concept:clti', { label: 'CLTI Management' })
    const kb = buildKB([c], [paper('1', { conceptId: 'concept:clti' })], {})
    expect(kb.groups).toHaveLength(1)
    expect(kb.groups[0].group.id).toBe('concept:clti')
    expect(kb.groups[0].papers.map((x) => x.id)).toEqual(['1'])
  })

  it('files by sourcePmids fallback', () => {
    const c = concept('concept:clti', { sourcePmids: ['99'] })
    const kb = buildKB([c], [paper('p99', { pmid: '99' })], {})
    expect(kb.groups[0].papers.map((x) => x.id)).toEqual(['p99'])
  })

  it('puts papers with no home in the unfiled bucket', () => {
    const kb = buildKB([], [paper('1')], {})
    expect(kb.unfiled.map((x) => x.id)).toEqual(['1'])
    expect(kb.counts.papers).toBe(1)
  })

  it('does not show concepts that hold no papers', () => {
    expect(buildKB([concept('concept:empty')], [], {}).groups).toHaveLength(0)
  })

  it('orders concepts by paper count then alphabetically', () => {
    const a = concept('concept:a', { label: 'Aaa', sourcePmids: ['1'] })
    const b = concept('concept:b', { label: 'Bbb', sourcePmids: ['2', '3'] })
    const kb = buildKB([a, b], [paper('1'), paper('2'), paper('3')], {})
    expect(kb.groups.map((g) => g.group.id)).toEqual(['concept:b', 'concept:a'])
  })
})

describe('buildKB search', () => {
  const c = concept('concept:clti', {
    label: 'CLTI Management',
    summary: 'Revascularization improves limb salvage.',
    tags: ['amputation-free survival'],
    sourcePmids: ['1', '2'],
  })
  const p1 = paper('1', { title: 'BEST-CLI trial', tags: ['bypass'] })
  const p2 = paper('2', { title: 'Endovascular registry', notes: 'read for journal club' })

  it('empty query returns the concept with all papers', () => {
    expect(buildKB([c], [p1, p2], { query: '' }).groups[0].papers).toHaveLength(2)
  })

  it('matches on concept summary and shows all its papers', () => {
    expect(buildKB([c], [p1, p2], { query: 'salvage' }).groups[0].papers).toHaveLength(2)
  })

  it('matches a paper field and shows only the matching paper', () => {
    expect(buildKB([c], [p1, p2], { query: 'endovascular' }).groups[0].papers.map((x) => x.id)).toEqual(['2'])
  })

  it('matches a paper by its own tag', () => {
    expect(buildKB([c], [p1, p2], { query: 'bypass' }).groups[0].papers.map((x) => x.id)).toEqual(['1'])
  })

  it('matches a paper by its note', () => {
    expect(buildKB([c], [p1, p2], { query: 'journal club' }).groups[0].papers.map((x) => x.id)).toEqual(['2'])
  })

  it('drops concepts with no field or paper match', () => {
    const kb = buildKB([c], [p1, p2], { query: 'carotid' })
    expect(kb.groups).toHaveLength(0)
    expect(kb.counts.papers).toBe(0)
  })
})

describe('buildKB domain filter', () => {
  const cVasc = concept('concept:a', { domain: 'vascular', sourcePmids: ['1'] })
  const cAi = concept('concept:b', { domain: 'ai', sourcePmids: ['2'] })

  it('narrows to concepts of one domain', () => {
    const kb = buildKB([cVasc, cAi], [paper('1'), paper('2')], { domain: 'ai' })
    expect(kb.groups.map((g) => g.group.id)).toEqual(['concept:b'])
  })

  it('"all" (or empty) keeps every domain', () => {
    expect(buildKB([cVasc, cAi], [paper('1'), paper('2')], { domain: 'all' }).groups).toHaveLength(2)
    expect(buildKB([cVasc, cAi], [paper('1'), paper('2')], { domain: '' }).groups).toHaveLength(2)
  })

  it('filters unfiled papers by domain too', () => {
    const kb = buildKB([], [paper('1', { domain: 'vascular' }), paper('2', { domain: 'ai' })], { domain: 'ai' })
    expect(kb.unfiled.map((x) => x.id)).toEqual(['2'])
  })
})
