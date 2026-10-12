// A cap reached partway through a scheduled digest: the REAL runDailyDigest, its model calls
// made through the real Anthropic SDK whose fetch is the guarded reserve/settle boundary.
// Search/selection/ranking are mocked as in dailyDigest.test.js; reading calls the model.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'

const mem = new Map()
const memStore = {
  get: async (c, k) => mem.get(`${c}/${k}`),
  put: async (c, k, v) => { mem.set(`${c}/${k}`, JSON.parse(JSON.stringify(v, (key, val) => (val instanceof Set ? Array.from(val) : val)))) },
  all: async (c) => Array.from(mem.entries()).filter(([key]) => key.startsWith(`${c}/`)).map(([, v]) => v),
  delete: async (c, k) => { mem.delete(`${c}/${k}`) },
  clear: async () => {},
}

vi.mock('./pipeline.js', async () => {
  const { extractStructured } = await import('../lib/anthropic.js')
  return {
    searchCandidates: vi.fn(async () => ({
      candidates: ['101', '102', '103'].map((pmid) => ({ id: pmid, pmid, title: `Paper ${pmid}`, topics: ['CLTI'] })),
      counts: [{ label: 'CLTI', found: 3, kept: 3 }], failed: [], skipped: 0, days: 3,
    })),
    // Shaped like the real runPaper: one extraction call, errors returned not thrown.
    runPaper: vi.fn(async (paper) => {
      try {
        await extractStructured({ model: 'claude-sonnet-5-5', content: `read ${paper.pmid}`, schema: { type: 'object', properties: {}, additionalProperties: false }, maxTokens: 64, thinking: { type: 'disabled' } })
        return { paper, citation: { pmid: paper.pmid }, design: 'RCT', source: { tier: 'full_text', hasBody: true }, sourceDoc: { text: 'x', tables: '' }, rows: [] }
      } catch (err) {
        return { paper, rows: [], error: err.message, errorObject: err }
      }
    }),
  }
})
vi.mock('./select.js', async (importOriginal) => ({
  ...(await importOriginal()),
  selectCandidates: vi.fn(async ({ candidates }) => candidates.map((c) => ({ ...c, score: 90, reason: 'fits' }))),
  planCoverageFallbacks: vi.fn(() => ({ candidates: [], rescuedTopics: [] })),
}))
vi.mock('./triage.js', () => ({ triage: vi.fn(async ({ candidates }) => candidates.map((c) => ({ id: c.id, score: 88, tier: 1, finding: 'f', relevance: 'r', check: { verdict: 'unchecked', reason: '' } }))) }))
vi.mock('../lib/trellis.js', () => ({ digestProjects: vi.fn(async () => []) }))

import { configureServerStore } from '../lib/store.js'
import { configureServerClient } from '../lib/anthropic.js'
import { runDailyDigest } from './dailyDigest.js'
import { makeGuardedFetch } from '../../supabase/functions/_shared/spending.js'
import { fakeLedger, fakeProvider } from '../lib/spendingFakes.js'

const okReply = (n) => ({ body: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } } })

function bind(ledger, provider) {
  const guarded = makeGuardedFetch({ ledger, dispatch: provider.dispatch, userId: 'A' })
  configureServerClient({ client: new Anthropic({ apiKey: 'sponsor-guarded', fetch: guarded.fetch, maxRetries: 2 }) })
  return guarded
}

beforeEach(() => {
  mem.clear()
  configureServerStore(memStore)
  mem.set('profile/me', { onboarded: true, northStars: ['CLTI'], rubric: { criteria: 'x', selectCount: 5, scoreFloor: 60 } })
})
afterAll(() => { configureServerClient({}); configureServerStore(null) })

describe('cap reached mid-digest', () => {
  it('stops before the next provider request and keeps what was read', async () => {
    const ledger = fakeLedger({ denyAfter: 1 })
    const provider = fakeProvider(okReply)
    bind(ledger, provider)
    const first = await runDailyDigest({ budgetMs: 60_000 })
    expect(first.phase).toBe('capped')
    expect(provider.sent).toHaveLength(1) // paper 101 only
    expect(ledger.calls.filter((c) => c === 'reserve')).toHaveLength(2) // 102 was refused at reservation
    const saved = mem.get('digests/daily:latest')
    expect(saved.server).toMatchObject({ phase: 'reading', capped: true })
    expect(saved.processedResults.map((r) => r.paper.id)).toEqual(['101'])

    // Next day / raised cap: the next tick resumes without re-reading paper 101.
    const ledger2 = fakeLedger()
    const provider2 = fakeProvider(okReply)
    bind(ledger2, provider2)
    const second = await runDailyDigest({ budgetMs: 60_000 })
    expect(second.phase).toBe('done')
    expect(provider2.sent.map((b) => b.messages[0].content)).toEqual(['read 102', 'read 103'])
  })

  it('an accounting outage mid-digest stops the same recoverable way, with no dispatch', async () => {
    const ledger = fakeLedger({ settleFails: 10 })
    const provider = fakeProvider(okReply)
    const guarded = bind(ledger, provider)
    const out = await runDailyDigest({ budgetMs: 60_000 })
    expect(out.phase).toBe('capped')
    expect(provider.sent).toHaveLength(1)
    expect(guarded.state.halted).toBe('settlement_failed')
    expect(ledger.calls.filter((c) => c === 'reserve')).toHaveLength(1)
  })
})
