import { beforeEach, describe, expect, it, vi } from 'vitest'

const sourceMocks = vi.hoisted(() => ({
  searchPubmed: vi.fn(),
  fetchCitations: vi.fn(),
  fetchCitation: vi.fn(),
}))

vi.mock('./sources.js', () => ({
  searchPubmed: sourceMocks.searchPubmed,
  fetchCitations: sourceMocks.fetchCitations,
  fetchCitation: sourceMocks.fetchCitation,
  searchPaceMs: () => 0,
  pmidToPmcid: vi.fn().mockResolvedValue(null),
  fetchAbstracts: vi.fn().mockResolvedValue('A sufficiently detailed abstract for testing.'),
  fetchPmcFullText: vi.fn(),
  fetchRegistry: vi.fn(),
  parseRegistryOutcomes: vi.fn().mockReturnValue([]),
  REGISTRY_OUTCOME_MAP: {},
}))

vi.mock('./extract.js', () => ({
  extractQuantities: vi.fn().mockResolvedValue({ design: 'trial', quantities: [] }),
}))

import { runPaper, searchCandidates } from './pipeline.js'

describe('digest retraction exclusion', () => {
  beforeEach(() => vi.clearAllMocks())

  it('removes retracted PubMed records before they become candidates', async () => {
    sourceMocks.searchPubmed.mockResolvedValue(['1', '2'])
    sourceMocks.fetchCitations.mockResolvedValue([
      { pmid: '1', title: 'Current evidence', pubtypes: ['Journal Article'], retracted: false },
      { pmid: '2', title: 'Withdrawn evidence', pubtypes: ['Retracted Publication'], retracted: true },
    ])

    const result = await searchCandidates({
      topics: [{ label: 'Topic', query: 'topic' }],
      perTopic: 10,
      days: 3,
      paceMs: 0,
    })

    expect(result.candidates.map((paper) => paper.pmid)).toEqual(['1'])
  })

  it('stops a restored candidate if PubMed now marks it retracted', async () => {
    sourceMocks.fetchCitation.mockResolvedValue({
      pmid: '2', title: 'Withdrawn evidence', pubtypes: ['Retracted Publication'], retracted: true,
    })

    const result = await runPaper({ id: '2', pmid: '2', title: 'Withdrawn evidence' })

    expect(result.retracted).toBe(true)
    expect(result.error).toMatch(/excluded from digest/i)
  })
})
