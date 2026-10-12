// An unresolved paid attempt partway through a scheduled digest: the REAL runDailyDigest inside a
// request scope, its model calls made through the real Anthropic SDK whose fetch is the guarded
// reserve/settle boundary, with the handler's rule for "unresolved" (a DISPATCHED attempt with no
// confirmed cost). Search/selection are mocked as in digestCapStop.test.js; reading and ranking
// call the model. The database half of the hold is proven in supabase/tests/.
import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'

const mem = new Map()
const memStore = {
  get: async (c, k) => mem.get(`${c}/${k}`),
  put: async (c, k, v) => { mem.set(`${c}/${k}`, JSON.parse(JSON.stringify(v, (key, val) => (val instanceof Set ? Array.from(val) : val)))) },
  all: async (c) => Array.from(mem.entries()).filter(([key]) => key.startsWith(`${c}/`)).map(([, v]) => v),
  delete: async (c, k) => { mem.delete(`${c}/${k}`) },
  clear: async () => {},
}
const call = async (content) => {
  const { extractStructured } = await import('../lib/anthropic.js')
  return extractStructured({ model: 'claude-sonnet-5-5', content, schema: { type: 'object', properties: {}, additionalProperties: false }, maxTokens: 64, thinking: { type: 'disabled' } })
}

vi.mock('./pipeline.js', () => ({
  searchCandidates: vi.fn(async () => ({
    candidates: ['101', '102', '103'].map((pmid) => ({ id: pmid, pmid, title: `Paper ${pmid}`, topics: ['CLTI'] })),
    counts: [{ label: 'CLTI', found: 3, kept: 3 }], failed: [], skipped: 0, days: 3,
  })),
  // Shaped like the real runPaper: one extraction call, errors returned not thrown.
  runPaper: vi.fn(async (paper) => {
    if (paper.pmid === 'broken') return { paper, rows: [], error: 'No source text.' } // an ordinary failed paper: no model call
    try {
      await call(`read ${paper.pmid}`)
      return { paper, citation: { pmid: paper.pmid }, design: 'RCT', source: { tier: 'full_text', hasBody: true }, sourceDoc: { text: 'x', tables: '' }, rows: [] }
    } catch (err) {
      return { paper, rows: [], error: err.message, errorObject: err }
    }
  }),
}))
vi.mock('./select.js', async (importOriginal) => ({
  ...(await importOriginal()),
  selectCandidates: vi.fn(async ({ candidates }) => candidates.map((c) => ({ ...c, score: 90, reason: 'fits' }))),
  planCoverageFallbacks: vi.fn(() => ({ candidates: [], rescuedTopics: [] })),
}))
// Ranking is one model call, as in the app; a failure throws.
vi.mock('./triage.js', () => ({ triage: vi.fn(async ({ candidates }) => { await call('rank'); return candidates.map((c) => ({ id: c.id, score: 88, tier: 1, finding: 'f', relevance: 'r', check: { verdict: 'unchecked', reason: '' } })) }) }))
vi.mock('../lib/trellis.js', () => ({ digestProjects: vi.fn(async () => []) }))

import { installServerScope } from '../lib/serverScope.js'
import { runDailyDigest, HELD_REASON } from './dailyDigest.js'
import { triage } from './triage.js'
import { searchCandidates } from './pipeline.js'
import { makeGuardedFetch } from '../../supabase/functions/_shared/spending.js'
import { fakeLedger, fakeProvider } from '../lib/spendingFakes.js'

const ok = (n) => ({ body: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } } })
const fail500 = { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'fake provider failure' } } }

// One scheduler tick's scope, built the way digest-run/handler.js builds it.
let scope = null
function tick(ledger, provider) {
  const run = { unresolved: null }
  const guarded = makeGuardedFetch({ ledger, dispatch: provider.dispatch, userId: 'A', onOutcome: (r) => { if (r.dispatched && (r.outcome === 'ambiguous' || r.accountingFailed)) run.unresolved ??= r.outcome } })
  scope = { userId: 'A', run, store: memStore, client: new Anthropic({ apiKey: 'sponsor-guarded', fetch: guarded.fetch, maxRetries: 2 }) }
  return { run, guarded }
}
const saved = () => mem.get('digests/daily:latest')

beforeAll(() => installServerScope(() => scope))
afterAll(() => installServerScope(null))
beforeEach(() => {
  mem.clear(); scope = null; triage.mockClear(); searchCandidates.mockClear()
  mem.set('profile/me', { onboarded: true, northStars: ['CLTI'], rubric: { criteria: 'x', selectCount: 5, scoreFloor: 60 } })
})

describe('an ambiguous extraction holds the run', () => {
  it('is not stored as a read-and-failed paper, a finished digest or a ranked one; progress is kept', async () => {
    const ledger = fakeLedger()
    const provider = fakeProvider((n) => (n === 2 ? fail500 : ok(n))) // paper 102 fails after dispatch
    const { run, guarded } = tick(ledger, provider)
    const out = await runDailyDigest({ budgetMs: 60_000 })
    expect(out).toMatchObject({ phase: 'held', read: 1 })
    expect(run.unresolved).toBe('ambiguous')
    expect(provider.sent.map((b) => b.messages[0].content)).toEqual(['read 101', 'read 102']) // no SDK retry, no paper 103, no ranking
    expect(guarded.state.dispatched).toBe(2)
    expect(triage).not.toHaveBeenCalled()
    expect(saved().server).toMatchObject({ phase: 'reading', held: { reason: HELD_REASON } })
    expect(saved().server.finishedAt).toBeUndefined()
    expect(saved().processedResults.map((r) => r.paper.id)).toEqual(['101']) // 102 is NOT recorded as processed
    expect([...ledger.rows.values()].map((r) => r.state)).toEqual(['settled', 'ambiguous'])
  })

  it('once released, the next tick reads the held paper again, finishes, and drops the held marker', async () => {
    tick(fakeLedger(), fakeProvider((n) => (n === 2 ? fail500 : ok(n))))
    await runDailyDigest({ budgetMs: 60_000 })
    const provider = fakeProvider(ok)
    tick(fakeLedger(), provider)
    const out = await runDailyDigest({ budgetMs: 60_000 })
    expect(out.phase).toBe('done')
    expect(searchCandidates).toHaveBeenCalledTimes(1) // resumed, not searched again
    expect(provider.sent.map((b) => b.messages[0].content)).toEqual(['read 102', 'read 103', 'rank'])
    expect(saved().server.phase).toBe('done')
    expect(saved().server.held).toBeUndefined()
    expect(saved().results.map((r) => r.paper.id)).toEqual(['101', '102', '103'])
  })

  it('a paper that came back while its attempt could not be recorded is kept, and the run still holds', async () => {
    const ledger = fakeLedger({ settleFails: 10 }) // the provider answered; settling the cost failed
    const provider = fakeProvider(ok)
    const { run } = tick(ledger, provider)
    const out = await runDailyDigest({ budgetMs: 60_000 })
    expect(out.phase).toBe('held')
    expect(run.unresolved).toBe('settlement_failed')
    expect(provider.sent).toHaveLength(1)
    expect(saved().processedResults.map((r) => r.paper.id)).toEqual(['101'])
    expect(saved().server).toMatchObject({ phase: 'reading', held: { reason: HELD_REASON } })
    expect([...ledger.rows.values()].map((r) => r.state)).toEqual(['reserved']) // still counted in full
  })
})

describe('an ambiguous ranking holds the run', () => {
  it('keeps every paper read, stays in the rank phase, and is not finished', async () => {
    const provider = fakeProvider((n) => (n === 4 ? fail500 : ok(n)))
    tick(fakeLedger(), provider)
    const out = await runDailyDigest({ budgetMs: 60_000 })
    expect(out).toMatchObject({ phase: 'held', read: 3 })
    expect(provider.sent).toHaveLength(4)
    expect(saved().server).toMatchObject({ phase: 'rank', held: { reason: HELD_REASON } })
    expect(saved().processedResults).toHaveLength(3)
    expect(saved().triaged).toEqual({})
    // Released: only the ranking is sent again.
    const again = fakeProvider(ok)
    tick(fakeLedger(), again)
    expect((await runDailyDigest({ budgetMs: 60_000 })).phase).toBe('done')
    expect(again.sent.map((b) => b.messages[0].content)).toEqual(['rank'])
  })
})

describe('what must not become a hold', () => {
  it('a cap denial is still "capped": nothing was dispatched, so nothing is unresolved', async () => {
    const provider = fakeProvider(ok)
    const { run } = tick(fakeLedger({ denyAfter: 1 }), provider)
    const out = await runDailyDigest({ budgetMs: 60_000 })
    expect(out.phase).toBe('capped')
    expect(run.unresolved).toBeNull()
    expect(saved().server).toMatchObject({ phase: 'reading', capped: true })
    expect(saved().server.held).toBeUndefined()
  })

  it('accounting unavailable before dispatch is still "capped", not held', async () => {
    const provider = fakeProvider(ok)
    const { run } = tick(fakeLedger({ reserveThrows: true }), provider)
    const out = await runDailyDigest({ budgetMs: 60_000 })
    expect(out.phase).toBe('capped')
    expect(run.unresolved).toBeNull()
    expect(provider.sent).toHaveLength(0)
  })

  it('an ordinary failed paper (no paid attempt) is still recorded as failed and the digest finishes', async () => {
    searchCandidates.mockResolvedValueOnce({ candidates: [{ id: 'broken', pmid: 'broken', title: 'Broken', topics: ['CLTI'] }, { id: '101', pmid: '101', title: 'Paper 101', topics: ['CLTI'] }], counts: [{ label: 'CLTI', found: 2, kept: 2 }], failed: [], skipped: 0, days: 3 })
    const { run } = tick(fakeLedger(), fakeProvider(ok))
    const out = await runDailyDigest({ budgetMs: 60_000 })
    expect(out.phase).toBe('done')
    expect(run.unresolved).toBeNull()
    expect(saved().processedResults.map((r) => [r.paper.id, !!r.error])).toEqual([['broken', true], ['101', false]])
  })
})
