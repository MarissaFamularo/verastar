import { describe, expect, it, vi } from 'vitest'
import {
  acknowledgeRetractionPatch,
  citationIndicatesRetraction,
  excludeRetracted,
  hasRetractedPublicationType,
  paperIndicatesRetraction,
  pendingRetractionAlerts,
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

describe('persisted retraction alerts', () => {
  const retracted = { id: '1', pmid: '1', retracted: true, retraction: { retracted: true, source: 'PubMed', checkedAt: '2026-08-05T12:00:00.000Z' } }
  const kept = { id: '2', pmid: '2', retracted: true, retraction: { retracted: true, acknowledgedAt: '2026-08-06T12:00:00.000Z' } }
  const current = { id: '3', pmid: '3', title: 'Current' }

  it('pending alerts are the retracted records not yet kept or deleted', () => {
    expect(pendingRetractionAlerts([retracted, kept, current]).map((p) => p.id)).toEqual(['1'])
    expect(pendingRetractionAlerts(undefined)).toEqual([])
  })

  it('keeping a paper acknowledges the alert without clearing the retraction', () => {
    const patch = acknowledgeRetractionPatch(retracted, '2026-08-07T00:00:00.000Z')
    expect(patch).toEqual({
      retracted: true,
      retraction: { retracted: true, source: 'PubMed', checkedAt: '2026-08-05T12:00:00.000Z', acknowledgedAt: '2026-08-07T00:00:00.000Z' },
    })
    expect(pendingRetractionAlerts([{ ...retracted, ...patch }])).toEqual([])
    expect(paperIndicatesRetraction({ ...retracted, ...patch })).toBe(true)
    // A legacy record flagged only by citation still gets a complete retraction object.
    expect(acknowledgeRetractionPatch({ citation: { pubtypes: ['Retracted Publication'] } }, 'T').retraction).toEqual({
      source: 'PubMed', retracted: true, acknowledgedAt: 'T',
    })
  })

  it('excludeRetracted drops kept and unkept retractions alike', () => {
    expect(excludeRetracted([retracted, kept, current])).toEqual([current])
  })
})
