// weekend.test.js — the pure Weekend Read helpers. Locks the trust-critical shaping: a thread can
// only cite REAL saved papers (no invented pmids), empty/paperless threads are dropped, and the
// content builder feeds Claude the profile + papers it needs. The Claude call itself isn't tested.

import { describe, it, expect } from 'vitest'
import { shapeWeekendRead, buildWeekendContent } from './weekend.js'

const paper = (id, over = {}) => ({
  id,
  pmid: over.pmid ?? id,
  title: over.title || `Paper ${id}`,
  finding: over.finding ?? '',
  relevance: over.relevance ?? '',
  tags: over.tags ?? [],
})

describe('shapeWeekendRead', () => {
  const papers = [paper('111'), paper('222'), paper('333')]

  it('keeps only pmids that map to a real saved paper', () => {
    const raw = {
      opener: 'Some emerged.',
      threads: [{ anchor: 'Limb Preservation Program', pmids: ['111', '999', '222'], narrative: 'They converge.' }],
      gaps: [],
    }
    const out = shapeWeekendRead(raw, { papers })
    expect(out.threads).toHaveLength(1)
    expect(out.threads[0].pmids).toEqual(['111', '222']) // 999 (invented) dropped
  })

  it('drops a thread left with no valid papers', () => {
    const raw = { threads: [{ anchor: 'X', pmids: ['999'], narrative: 'nope' }], gaps: [] }
    expect(shapeWeekendRead(raw, { papers }).threads).toHaveLength(0)
  })

  it('drops a thread with an empty narrative', () => {
    const raw = { threads: [{ anchor: 'X', pmids: ['111'], narrative: '  ' }], gaps: [] }
    expect(shapeWeekendRead(raw, { papers }).threads).toHaveLength(0)
  })

  it('dedups pmids within a thread and defaults a blank anchor to Cross-cutting', () => {
    const raw = { threads: [{ anchor: '', pmids: ['111', '111', '222'], narrative: 'ok' }], gaps: [] }
    const t = shapeWeekendRead(raw, { papers }).threads[0]
    expect(t.pmids).toEqual(['111', '222'])
    expect(t.anchor).toBe('Cross-cutting')
  })

  it('matches papers that carry only an id (doi-only, no pmid)', () => {
    const doiPapers = [{ id: '10.1/x', title: 'DOI paper' }]
    const raw = { threads: [{ anchor: 'X', pmids: ['10.1/x'], narrative: 'ok' }], gaps: [] }
    expect(shapeWeekendRead(raw, { papers: doiPapers }).threads).toHaveLength(1)
  })

  it('trims the opener and filters blank gaps', () => {
    const raw = { opener: '  Hello.  ', threads: [], gaps: ['Nothing touched carotid.', '', '  '] }
    const out = shapeWeekendRead(raw, { papers })
    expect(out.opener).toBe('Hello.')
    expect(out.gaps).toEqual(['Nothing touched carotid.'])
  })

  it('is safe on empty / missing input', () => {
    expect(shapeWeekendRead(null, { papers })).toEqual({ opener: '', threads: [], gaps: [] })
    expect(shapeWeekendRead({}, {})).toEqual({ opener: '', threads: [], gaps: [] })
  })
})

describe('buildWeekendContent', () => {
  it('includes north stars, projects, and each paper with its finding', () => {
    const content = buildWeekendContent({
      papers: [paper('111', { title: 'BASIL-3', finding: 'Drug-coated devices helped.', tags: ['clti', 'bypass'] })],
      northStars: ['Carotid revascularization'],
      projects: ['Limb Preservation Program'],
    })
    expect(content).toContain('Carotid revascularization')
    expect(content).toContain('Limb Preservation Program')
    expect(content).toContain('[111] BASIL-3')
    expect(content).toContain('Drug-coated devices helped.')
    expect(content).toContain('clti, bypass')
  })

  it('handles an empty profile without crashing', () => {
    const content = buildWeekendContent({ papers: [paper('1')], northStars: [], projects: [] })
    expect(content).toContain('(none set)')
  })
})
