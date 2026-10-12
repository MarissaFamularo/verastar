import { beforeEach, describe, expect, it, vi } from 'vitest'

const sourceMocks = vi.hoisted(() => ({
  searchPubmed: vi.fn(),
  fetchCitations: vi.fn(),
  fetchCitation: vi.fn(),
  fetchAbstractsByPmid: vi.fn(async () => ({})),
}))

vi.mock('./sources.js', () => ({
  searchPubmed: sourceMocks.searchPubmed,
  fetchCitations: sourceMocks.fetchCitations,
  fetchCitation: sourceMocks.fetchCitation,
  fetchAbstractsByPmid: sourceMocks.fetchAbstractsByPmid,
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
  beforeEach(() => {
    vi.clearAllMocks()
    sourceMocks.fetchAbstractsByPmid.mockResolvedValue({})
  })

  it('removes retracted PubMed records before they become candidates', async () => {
    sourceMocks.searchPubmed.mockResolvedValue(['1', '2'])
    sourceMocks.fetchCitations.mockResolvedValue([
      { pmid: '1', title: 'Current topic evidence', pubtypes: ['Journal Article'], retracted: false },
      { pmid: '2', title: 'Withdrawn topic evidence', pubtypes: ['Retracted Publication'], retracted: true },
    ])

    const result = await searchCandidates({
      topics: [{ label: 'Topic', query: 'topic' }],
      perTopic: 10,
      days: 3,
      paceMs: 0,
    })

    expect(result.candidates.map((paper) => paper.pmid)).toEqual(['1'])
  })

  it('carries only live topic-to-north-star mappings onto candidates', async () => {
    sourceMocks.searchPubmed.mockResolvedValue(['1'])
    sourceMocks.fetchCitations.mockResolvedValue([{ pmid: '1', title: 'Organ allocation outcomes', pubtypes: ['Journal Article'] }])

    const result = await searchCandidates({
      topics: [{ label: 'Allocation', query: 'organ allocation', northStars: ['Allocation equity', 'Deleted star'] }],
      northStars: ['Allocation equity'],
      perTopic: 10,
      days: 3,
      paceMs: 0,
    })

    expect(result.candidates[0].topicSteering).toEqual([
      { topic: 'Allocation', northStars: ['Allocation equity'] },
    ])
  })

  it('returns the bounded unseen pool before the per-topic cap', async () => {
    sourceMocks.searchPubmed.mockResolvedValue(['newest', 'middle', 'older'])
    sourceMocks.fetchCitations.mockResolvedValue([
      { pmid: 'newest', title: 'Newest registry methods', pubtypes: ['Journal Article'] },
      { pmid: 'middle', title: 'Middle registry methods', pubtypes: ['Journal Article'] },
      { pmid: 'older', title: 'Older registry methods but potentially more relevant', pubtypes: ['Journal Article'] },
    ])

    const result = await searchCandidates({
      topics: [{ label: 'Registry methods', query: 'registry methods' }],
      perTopic: 1,
      days: 7,
      paceMs: 0,
    })

    expect(result.cap).toBe(1)
    expect(result.candidates.map((paper) => paper.pmid)).toEqual(['newest', 'middle', 'older'])
  })

  it('searches the compiled title/abstract query and drops an off-topic hit before scoring', async () => {
    sourceMocks.searchPubmed.mockResolvedValue(['burns', 'clti'])
    sourceMocks.fetchCitations.mockResolvedValue([
      { pmid: 'burns', title: 'Flap Reconstruction for Deep Hand Burns: A Case Series.', pubtypes: ['Journal Article'] },
      { pmid: 'clti', title: 'Outcomes of revascularization for chronic limb-threatening ischemia.', pubtypes: ['Journal Article'] },
    ])
    sourceMocks.fetchAbstractsByPmid.mockResolvedValue({
      burns: 'Amputation was considered before flap coverage. Amputation was later declined.',
      clti: 'Chronic limb-threatening ischemia was treated with endovascular revascularization.',
    })

    const result = await searchCandidates({
      topics: [{
        label: 'Limb preservation / CLTI / Diabetic foot',
        query: 'chronic limb-threatening ischemia OR CLTI OR diabetic foot OR amputation',
      }],
      perTopic: 10,
      days: 3,
      paceMs: 0,
    })

    expect(sourceMocks.searchPubmed).toHaveBeenCalledWith(
      '"chronic limb threatening ischemia"[tiab] OR CLTI[tiab] OR "diabetic foot"[tiab] OR amputation[tiab]',
      expect.objectContaining({ days: 3 }),
    )
    expect(result.candidates.map((paper) => paper.pmid)).toEqual(['clti'])
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
