// kb.test.js — the pure KB search/filter. Locks the browse rules: category > group > paper
// grouping (a group is a concept OR a category anchor holding papers directly), search reaching
// title/summary/tags/notes across group and papers, the category filter, and the unfiled bucket.

import { describe, it, expect } from 'vitest'
import { buildKB } from './kb.js'

const anchor = (id, over = {}) => ({
  id,
  kind: over.kind || 'northStar',
  label: over.label || id,
  color: over.color || '#fff',
  sourcePmids: over.sourcePmids ?? [],
})
const concept = (id, over = {}) => ({
  id,
  kind: 'concept',
  label: over.label || id,
  category: over.category ?? 'ns:clti',
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
  category: over.category ?? null,
  conceptId: over.conceptId ?? null,
})

describe('buildKB grouping', () => {
  it('files a paper under its concept by conceptId', () => {
    const c = concept('concept:sub', { label: 'CLTI Risk Stratification' })
    const p = paper('1', { conceptId: 'concept:sub' })
    const kb = buildKB([c], [p], {})
    expect(kb.groups).toHaveLength(1)
    expect(kb.groups[0].group.id).toBe('concept:sub')
    expect(kb.groups[0].papers.map((x) => x.id)).toEqual(['1'])
  })

  it('files a paper directly under a category anchor (topic IS a north star)', () => {
    const a = anchor('ns:carotid', { label: 'Carotid revascularization' })
    const p = paper('1', { category: 'ns:carotid', conceptId: null }) // no concept → under the anchor
    const kb = buildKB([a], [p], {})
    expect(kb.groups).toHaveLength(1)
    expect(kb.groups[0].group.id).toBe('ns:carotid')
    expect(kb.unfiled).toHaveLength(0)
  })

  it('files by sourcePmids fallback', () => {
    const c = concept('concept:sub', { sourcePmids: ['99'] })
    const p = paper('p99', { pmid: '99' })
    const kb = buildKB([c], [p], {})
    expect(kb.groups[0].papers.map((x) => x.id)).toEqual(['p99'])
  })

  it('puts papers with no home in the unfiled bucket', () => {
    const kb = buildKB([], [paper('1')], {})
    expect(kb.unfiled.map((x) => x.id)).toEqual(['1'])
    expect(kb.counts.papers).toBe(1)
  })

  it('does not show grouping nodes that hold no papers', () => {
    const empty = concept('concept:empty')
    const kb = buildKB([empty], [], {})
    expect(kb.groups).toHaveLength(0)
  })

  it('orders groups by paper count then alphabetically', () => {
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

  it('empty query returns the group with all papers', () => {
    expect(buildKB([c], [p1, p2], { query: '' }).groups[0].papers).toHaveLength(2)
  })

  it('matches on group summary and shows all its papers', () => {
    const kb = buildKB([c], [p1, p2], { query: 'salvage' })
    expect(kb.groups[0].papers).toHaveLength(2)
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

  it('drops groups with no field or paper match', () => {
    const kb = buildKB([c], [p1, p2], { query: 'carotid' })
    expect(kb.groups).toHaveLength(0)
    expect(kb.counts.papers).toBe(0)
  })
})

describe('buildKB category filter', () => {
  const cVasc = concept('concept:a', { category: 'ns:clti', sourcePmids: ['1'] })
  const cAi = concept('concept:b', { category: 'ns:ai', sourcePmids: ['2'] })

  it('narrows to groups of one category (by the concept parent)', () => {
    const kb = buildKB([cVasc, cAi], [paper('1'), paper('2')], { category: 'ns:ai' })
    expect(kb.groups.map((g) => g.group.id)).toEqual(['concept:b'])
  })

  it('narrows to a category anchor group directly', () => {
    const a = anchor('ns:carotid', { label: 'Carotid' })
    const kb = buildKB([a, cVasc], [paper('1', { conceptId: 'concept:a' }), paper('9', { category: 'ns:carotid' })], {
      category: 'ns:carotid',
    })
    expect(kb.groups.map((g) => g.group.id)).toEqual(['ns:carotid'])
  })

  it('"all" (or empty) keeps every category', () => {
    expect(buildKB([cVasc, cAi], [paper('1'), paper('2')], { category: 'all' }).groups).toHaveLength(2)
    expect(buildKB([cVasc, cAi], [paper('1'), paper('2')], { category: '' }).groups).toHaveLength(2)
  })

  it('filters unfiled papers by category too', () => {
    const kb = buildKB([], [paper('1', { category: 'ns:clti' }), paper('2', { category: 'ns:ai' })], {
      category: 'ns:ai',
    })
    expect(kb.unfiled.map((x) => x.id)).toEqual(['2'])
  })
})
