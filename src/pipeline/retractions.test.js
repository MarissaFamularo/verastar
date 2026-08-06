import { describe, expect, it, vi } from 'vitest'
import {
  citationIndicatesRetraction,
  hasRetractedPublicationType,
  paperIndicatesRetraction,
  removePaperFromConcepts,
  refreshSavedRetractions,
} from './retractions.js'

describe('PubMed retraction classification', () => {
  it('matches Retracted Publication exactly, without confusing the retraction notice', () => {
    expect(hasRetractedPublicationType(['Journal Article', 'Retracted Publication'])).toBe(true)
    expect(hasRetractedPublicationType(['Retraction of Publication'])).toBe(false)
  })

  it('recognizes current and legacy saved citation shapes', () => {
    expect(citationIndicatesRetraction({ pubtypes: ['Retracted Publication'] })).toBe(true)
    expect(citationIndicatesRetraction({ title: 'A trial of treatment. [Retracted]' })).toBe(true)
    expect(citationIndicatesRetraction('Smith · Retracted Publication · 2020')).toBe(true)
    expect(paperIndicatesRetraction({ retraction: { retracted: true } })).toBe(true)
    expect(citationIndicatesRetraction({ pubtypes: ['Retraction of Publication'] })).toBe(false)
  })
})

describe('retracted-paper deletion cleanup', () => {
  it('removes the PMID from every concept without mutating or deleting the concepts', () => {
    const concepts = [
      { id: 'a', sourcePmids: ['1', '2'], summary: 'keep' },
      { id: 'b', sourcePmids: [1] },
      { id: 'c', sourcePmids: ['3'] },
    ]
    expect(removePaperFromConcepts(concepts, { pmid: 1 })).toEqual([
      { id: 'a', sourcePmids: ['2'], summary: 'keep' },
      { id: 'b', sourcePmids: [] },
    ])
    expect(concepts[0].sourcePmids).toEqual(['1', '2'])
  })
})

describe('refreshSavedRetractions', () => {
  it('checks saved PMIDs and persists only newly retracted papers', async () => {
    const papers = [
      { id: '1', pmid: '1', title: 'Withdrawn later', citation: { title: 'Withdrawn later', doi: '10.1/keep-me' } },
      { id: '2', pmid: '2', title: 'Still current', citation: { title: 'Still current' } },
    ]
    const fetchCurrent = vi.fn().mockResolvedValue([
      { pmid: '1', title: 'Withdrawn later', pubtypes: ['Retracted Publication'], retracted: true },
      { pmid: '2', title: 'Still current', pubtypes: ['Journal Article'], retracted: false },
    ])
    const persist = vi.fn().mockResolvedValue(undefined)
    const onPatch = vi.fn()

    const result = await refreshSavedRetractions(papers, {
      fetchCurrent,
      persist,
      onPatch,
      now: () => '2026-08-05T12:00:00.000Z',
    })

    expect(fetchCurrent).toHaveBeenCalledWith(['1', '2'])
    expect(result).toHaveLength(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][1]).toMatchObject({
      id: '1',
      retracted: true,
      retraction: { source: 'PubMed', checkedAt: '2026-08-05T12:00:00.000Z' },
      citation: { doi: '10.1/keep-me', retracted: true },
    })
    expect(onPatch).toHaveBeenCalledWith('1', expect.objectContaining({ retracted: true }))
  })

  it('leaves the library unchanged when the current-status fetch fails', async () => {
    const persist = vi.fn()
    const result = await refreshSavedRetractions([{ id: '1', pmid: '1' }], {
      fetchCurrent: vi.fn().mockRejectedValue(new Error('offline')),
      persist,
    })
    expect(result).toEqual([])
    expect(persist).not.toHaveBeenCalled()
  })
})
