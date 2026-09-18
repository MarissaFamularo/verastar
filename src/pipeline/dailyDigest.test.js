// The headless daily digest: resume and budget behavior, on an in-memory store with the
// network and model steps mocked. What is NOT mocked: the digest record shape, the seen
// ledger, the selection helpers, and the phase machine — the parts a scheduled run must get
// right for the app to restore the digest as if the reader had run it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mem = new Map()
const memStore = {
  get: async (c, k) => mem.get(`${c}/${k}`),
  put: async (c, k, v) => { mem.set(`${c}/${k}`, JSON.parse(JSON.stringify(v, (key, val) => (val instanceof Set ? Array.from(val) : val)))) },
  all: async (c) => Array.from(mem.entries()).filter(([key]) => key.startsWith(`${c}/`)).map(([, v]) => v),
  delete: async (c, k) => { mem.delete(`${c}/${k}`) },
  clear: async () => {},
}

const PAPERS = ['101', '102', '103']
vi.mock('./pipeline.js', () => ({
  searchCandidates: vi.fn(async () => ({
    candidates: PAPERS.map((pmid) => ({ id: pmid, pmid, title: `Paper ${pmid}`, topics: ['CLTI'] })),
    counts: [{ label: 'CLTI', found: 3, kept: 3 }],
    failed: [],
    skipped: 0,
    days: 3,
  })),
  runPaper: vi.fn(async (paper) => ({
    paper,
    citation: { pmid: paper.pmid, title: `Paper ${paper.pmid}` },
    design: 'RCT',
    source: { tier: 'full_text', hasBody: true },
    sourceDoc: { text: 'Mortality was 10%.', tables: '' },
    rows: [],
  })),
}))
vi.mock('./select.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    selectCandidates: vi.fn(async ({ candidates }) => candidates.map((c) => ({ ...c, score: 90, reason: 'fits' }))),
    planCoverageFallbacks: vi.fn(() => ({ candidates: [], rescuedTopics: [] })),
  }
})
vi.mock('./triage.js', () => ({
  triage: vi.fn(async ({ candidates }) => candidates.map((c) => ({ id: c.id, score: 88, tier: 1, finding: 'f', relevance: 'r', check: { verdict: 'unchecked', reason: '' } }))),
}))
vi.mock('../lib/trellis.js', () => ({ digestProjects: vi.fn(async () => []) }))

import { configureServerStore } from '../lib/store.js'
import { runDailyDigest, remainingToRead, takesById, RANK_HANDOFF_FRACTION } from './dailyDigest.js'
import { schedulerMayRun, reviveDigest } from '../lib/digestStore.js'
import { runPaper } from './pipeline.js'

beforeEach(() => {
  mem.clear()
  configureServerStore(memStore)
  mem.set('profile/me', { onboarded: true, northStars: ['CLTI'], rubric: { criteria: 'x', selectCount: 5, scoreFloor: 60 } })
  vi.mocked(runPaper).mockClear()
})

describe('pure helpers', () => {
  it('remainingToRead is the chosen minus the processed', () => {
    const cands = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(remainingToRead(cands, new Set(['a', 'c']), [{ paper: { id: 'a' } }]).map((c) => c.id)).toEqual(['c'])
  })
  it('takesById keeps the fields the cards read', () => {
    expect(takesById([{ id: 'x', score: 1, tier: 2, finding: 'f', relevance: 'r' }]).x).toMatchObject({ score: 1, tier: 2, finding: 'f' })
  })
})

describe('schedulerMayRun', () => {
  it('runs on no digest, an opened digest, an empty digest, or an unfinished scheduler run', () => {
    expect(schedulerMayRun(undefined)).toBe(true)
    expect(schedulerMayRun({ kind: 'daily', results: [{}], openedAt: '2026-09-17T12:00:00Z' })).toBe(true)
    expect(schedulerMayRun({ kind: 'daily', results: [] })).toBe(true)
    expect(schedulerMayRun({ kind: 'daily', results: [{}], runBy: 'scheduler', server: { phase: 'reading' } })).toBe(true)
  })
  it('never replaces a finished digest nobody opened', () => {
    expect(schedulerMayRun({ kind: 'daily', results: [{}], openedAt: null, runBy: 'user' })).toBe(false)
    expect(schedulerMayRun({ kind: 'daily', results: [{}], openedAt: null, runBy: 'scheduler', server: { phase: 'done' } })).toBe(false)
  })
})

describe('runDailyDigest', () => {
  it('completes a digest in one tick and leaves a record the app can revive', async () => {
    const out = await runDailyDigest({ budgetMs: 60_000 })
    expect(out.phase).toBe('done')
    expect(out.papers).toBe(3)
    const revived = reviveDigest(mem.get('digests/daily:latest'))
    expect(revived.results).toHaveLength(3)
    expect(Object.keys(revived.triaged)).toHaveLength(3)
    expect(revived.runBy).toBe('scheduler')
    expect(revived.server.phase).toBe('done')
    expect(revived.openedAt).toBeNull()
    expect(mem.get('seen/pmids')).toBeTruthy()
    expect(mem.get('digests/daily:last-successful-scan')).toMatchObject({ kind: 'daily-scan-checkpoint', windowDays: 3 })
  })

  it('stops at the budget, persists progress, and resumes on the next tick without re-reading', async () => {
    let t = 0
    const now = () => t
    vi.mocked(runPaper).mockImplementation(async (paper) => {
      t += 40_000 // each paper "takes" 40s
      return { paper, citation: { pmid: paper.pmid }, design: 'RCT', source: { tier: 'full_text', hasBody: true }, sourceDoc: { text: '', tables: '' }, rows: [] }
    })
    const first = await runDailyDigest({ budgetMs: 70_000, now })
    expect(first.phase).toBe('reading')
    expect(first.read).toBe(2)
    const mid = mem.get('digests/daily:latest')
    expect(mid.server.phase).toBe('reading')
    expect(mid.processedResults).toHaveLength(2)
    expect(schedulerMayRun(mid)).toBe(true) // unfinished scheduler run may continue
    expect(mem.get('seen/pmids')).toBeUndefined() // nothing stamped until the run finishes

    t = 0
    const second = await runDailyDigest({ budgetMs: 70_000, now })
    expect(second.phase).toBe('rank') // read the last paper (40s of 70s), so ranking waits for a fresh tick
    expect(second.read).toBe(1)
    expect(vi.mocked(runPaper)).toHaveBeenCalledTimes(3)
    t = 0
    const third = await runDailyDigest({ budgetMs: 70_000, now })
    expect(third.phase).toBe('done')
    expect(third.read).toBe(0)
    expect(vi.mocked(runPaper)).toHaveBeenCalledTimes(3) // nothing re-read
    expect(mem.get('digests/daily:latest').results).toHaveLength(3)
    expect(mem.get('seen/pmids')).toBeTruthy()
  })

  it('hands ranking to the next tick when reading used most of the budget', async () => {
    let t = 0
    const now = () => t
    vi.mocked(runPaper).mockImplementation(async (paper) => {
      t += 20_000 // three papers = 60s of a 100s budget, past the handoff fraction
      return { paper, citation: { pmid: paper.pmid }, design: 'RCT', source: { tier: 'full_text', hasBody: true }, sourceDoc: { text: '', tables: '' }, rows: [] }
    })
    expect(RANK_HANDOFF_FRACTION).toBeLessThan(0.6)
    const first = await runDailyDigest({ budgetMs: 100_000, now })
    expect(first.phase).toBe('rank')
    expect(first.read).toBe(3)
    expect(mem.get('digests/daily:latest').server.phase).toBe('rank')
    expect(mem.get('digests/daily:latest').triaged).toEqual({})
    t = 0
    const second = await runDailyDigest({ budgetMs: 100_000, now })
    expect(second.phase).toBe('done')
    expect(second.read).toBe(0)
    expect(Object.keys(mem.get('digests/daily:latest').triaged)).toHaveLength(3)
  })

  it('does nothing for a profile that has not onboarded', async () => {
    mem.set('profile/me', { onboarded: false })
    expect((await runDailyDigest()).phase).toBe('empty')
    expect(mem.get('digests/daily:latest')).toBeUndefined()
  })
})
