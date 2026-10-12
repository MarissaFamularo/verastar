// The evidence window through the scheduled digest: the ranking call receives each paper's
// stored window (not its body text), a window survives a persisted mid-run resume, and an
// old row without one gets the explicit fallback. SYNTHETIC papers; network and model
// steps mocked exactly as in dailyDigest.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const mem = new Map()
const memStore = {
  get: async (c, k) => mem.get(`${c}/${k}`),
  put: async (c, k, v) => { mem.set(`${c}/${k}`, JSON.parse(JSON.stringify(v, (key, val) => (val instanceof Set ? Array.from(val) : val)))) },
  all: async (c) => Array.from(mem.entries()).filter(([key]) => key.startsWith(`${c}/`)).map(([, v]) => v),
  delete: async (c, k) => { mem.delete(`${c}/${k}`) },
  clear: async () => {},
}

const INTRO = 'An earlier trial reported a hazard ratio of 0.50 (95% CI 0.40-0.62) [3].'
const RESULT = 'The primary endpoint occurred in 61 of 405 and 58 of 407 patients.'

vi.mock('./pipeline.js', () => ({
  searchCandidates: vi.fn(async () => ({
    candidates: ['201', '202'].map((pmid) => ({ id: pmid, pmid, title: `Paper ${pmid}`, topics: ['CLTI'] })),
    counts: [{ label: 'CLTI', found: 2, kept: 2 }],
    failed: [],
    skipped: 0,
    days: 3,
  })),
  runPaper: vi.fn(),
}))
vi.mock('./select.js', async (importOriginal) => ({
  ...(await importOriginal()),
  selectCandidates: vi.fn(async ({ candidates }) => candidates.map((c) => ({ ...c, score: 90, reason: 'fits' }))),
  planCoverageFallbacks: vi.fn(() => ({ candidates: [], rescuedTopics: [] })),
}))
vi.mock('./triage.js', () => ({
  triage: vi.fn(async ({ candidates }) => candidates.map((c) => ({ id: c.id, score: 88, tier: 1, finding: 'f', relevance: 'r', check: { verdict: 'unchecked', reason: '' } }))),
}))
vi.mock('../lib/trellis.js', () => ({ digestProjects: vi.fn(async () => []) }))

import { configureServerStore } from '../lib/store.js'
import { runDailyDigest } from './dailyDigest.js'
import { runPaper } from './pipeline.js'
import { triage } from './triage.js'
import { selectEvidenceWindow, EVIDENCE_WINDOW_VERSION } from './evidenceWindow.js'

// What runPaper now returns for a full-text paper: the complete body as sourceDoc and the
// selected window beside it.
const fullTextResult = (paper) => ({
  paper,
  citation: { pmid: paper.pmid },
  design: 'RCT',
  source: { tier: 'full_text', hasBody: true },
  sourceDoc: { text: `${INTRO} ${RESULT}`, tables: '' },
  evidenceWindow: selectEvidenceWindow({ tier: 'full_text', text: `${INTRO} ${RESULT}`, sections: [{ label: 'Introduction', kind: 'background', text: INTRO }, { label: 'Results', kind: 'results', text: RESULT }], abstractParts: [] }),
  rows: [],
})

beforeEach(() => {
  mem.clear()
  configureServerStore(memStore)
  mem.set('profile/me', { onboarded: true, northStars: ['CLTI'], rubric: { criteria: 'x', selectCount: 5, scoreFloor: 60 } })
  vi.mocked(runPaper).mockReset()
  vi.mocked(triage).mockClear()
})

describe('scheduled ranking reads the evidence window', () => {
  it('passes each paper\'s stored window, never its body prefix', async () => {
    vi.mocked(runPaper).mockImplementation(async (paper) => fullTextResult(paper))
    await runDailyDigest({ budgetMs: 60_000 })
    const { candidates } = vi.mocked(triage).mock.calls[0][0]
    for (const c of candidates) {
      expect(c.summary).toContain(RESULT)
      expect(c.summary).not.toContain('0.50')
      expect(c.summary).toMatch(/^\[Evidence window: Results section/)
    }
    // The persisted digest still carries the complete verification corpus.
    const saved = mem.get('digests/daily:latest')
    expect(saved.processedResults[0].sourceDoc.text).toContain(INTRO)
    expect(saved.processedResults[0].evidenceWindow.version).toBe(EVIDENCE_WINDOW_VERSION)
  })

  it('a window survives a persisted mid-run resume and is what the next tick ranks', async () => {
    let t = 0
    const now = () => t
    vi.mocked(runPaper).mockImplementation(async (paper) => {
      t += 40_000
      return fullTextResult(paper)
    })
    const first = await runDailyDigest({ budgetMs: 30_000, now })
    expect(first.phase).toBe('reading')
    // Round-tripped through JSON by memStore, exactly like a real persisted record.
    expect(mem.get('digests/daily:latest').processedResults[0].evidenceWindow.kind).toBe('results')
    let phase = first.phase
    for (let i = 0; i < 4 && phase !== 'done'; i++) {
      t = 0
      phase = (await runDailyDigest({ budgetMs: 200_000, now })).phase
    }
    expect(phase).toBe('done')
    const { candidates } = vi.mocked(triage).mock.calls.at(-1)[0]
    expect(candidates).toHaveLength(2)
    expect(candidates.every((c) => c.summary.includes(RESULT) && !c.summary.includes('0.50'))).toBe(true)
  })

  it('an old saved full-text row resumed into ranking gets the explicit empty window', async () => {
    // A record a previous build left mid-run: processed rows have no evidenceWindow.
    vi.mocked(runPaper).mockImplementation(async (paper) => ({ ...fullTextResult(paper), evidenceWindow: undefined }))
    await runDailyDigest({ budgetMs: 60_000 })
    const { candidates } = vi.mocked(triage).mock.calls[0][0]
    expect(candidates.map((c) => c.summary)).toEqual(['', ''])
  })
})

describe('browser and scheduler build the same ranking input', () => {
  // The four triage callers. Each must read the shared window, so the browser digest,
  // the scheduled digest, Add a paper and a Library refresh rank from the same text.
  // (The digest screen's ranking call lives in lib/digestRunAndRank.js, which SpineCheck runs.)
  const callers = ['src/pipeline/dailyDigest.js', 'src/lib/digestRunAndRank.js', 'src/components/AddPaper.jsx', 'src/pipeline/refreshEvidence.js']
  for (const file of callers) {
    it(`${file} passes evidenceSummary(...) as the candidate summary`, () => {
      const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
      expect(src).toMatch(/summary: evidenceSummary\((?:r|res)\)/)
      expect(src).not.toMatch(/summary: (?:r|res)\.sourceDoc/)
    })
  }

  it('the digest screen ranks through that shared orchestration and has no ranking call of its own', () => {
    const src = readFileSync(new URL('../../src/components/SpineCheck.jsx', import.meta.url), 'utf8')
    expect(src).toMatch(/runAndRankDigest\(papers, options, \{/)
    expect(src).not.toMatch(/\btriage\(\{/)
  })
})
