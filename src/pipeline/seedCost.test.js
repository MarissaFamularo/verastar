// Starter loading must be free. This runs the REAL seeding path (runPaper in cacheOnly mode,
// the real savePaper and its background enrichment) against a stubbed Anthropic SDK that
// counts every model request, and proves the count stays at zero. The control case runs
// the same save with enrichment on and shows the counter does catch a paid call, so a zero
// is meaningful rather than a dead detector.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'

const modelCalls = vi.hoisted(() => [])

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    constructor() {
      this.messages = {
        create: async (req) => {
          modelCalls.push(req?.model || 'unknown')
          throw new Error('model call blocked in test')
        },
      }
    }
  }
  return { default: Anthropic }
})

// Free public-source fetches, canned. No network.
vi.mock('./sources.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchCitation: async (pmid) => ({ pmid, title: `Starter ${pmid}`, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, verified: true }),
  pmidToPmcid: async () => null,
  fetchAbstracts: async () => 'Background. Methods. Results: stroke or death occurred in 2.0% of patients.',
}))

// A shared-cache hit for every starter.
vi.mock('./evidenceCache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  lookupCachedExtraction: async () => ({ extraction: { design: 'rct', quantities: [] }, model: 'cached', source_tier: 'abstract_only' }),
  storeCachedExtraction: async () => { throw new Error('seeding must never write the cache') },
}))

import { configureServerStore } from '../lib/store.js'
import { configureServerClient } from '../lib/anthropic.js'
import { runPaper } from './pipeline.js'
import { savePaper } from './save.js'
import { seedLibraryIfDue } from './seed.js'

function memoryStore() {
  const data = new Map()
  const col = (c) => { if (!data.has(c)) data.set(c, new Map()); return data.get(c) }
  return {
    data,
    get: async (c, k) => col(c).get(k),
    put: async (c, k, v) => { col(c).set(k, v) },
    all: async (c) => [...col(c).values()],
    delete: async (c, k) => { col(c).delete(k) },
    clear: async (c) => { col(c).clear() },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 30))
let mem
const realFetch = globalThis.fetch

beforeAll(() => {
  // Any stray network request fails loudly instead of leaving the sandbox.
  globalThis.fetch = async (url) => { throw new Error(`unexpected fetch: ${url}`) }
  // A live model lane exists, so a paid call WOULD go out if any code made one.
  configureServerClient({ apiKey: 'test-key' })
})
afterAll(() => {
  globalThis.fetch = realFetch
  configureServerClient({})
  configureServerStore(null)
})
beforeEach(() => {
  modelCalls.length = 0
  mem = memoryStore()
  configureServerStore(mem)
})

describe('Starter loading is free', () => {
  it('seeds the shelf through the real pipeline with zero model calls', async () => {
    await mem.put('profile', 'me', { onboarded: true, specialty: 'vascular-surgery' })
    const rows = [
      { specialty: 'vascular-surgery', pmid: '101', rank: 1 },
      { specialty: 'general', pmid: '102', rank: 1 },
    ]
    const result = await seedLibraryIfDue({
      deps: { configured: true, signedIn: true, fetchReferenceRows: async () => rows, logEvent: () => {}, runPaper, savePaper },
    })
    await flush() // let the fire-and-forget background enrichment finish

    expect(result).toEqual({ seeded: 2, skipped: 0, complete: true })
    expect((await mem.all('papers')).map((p) => p.saveSource)).toEqual(['seed', 'seed'])
    expect(modelCalls).toEqual([])
  })

  it('control: the same save with enrichment on does reach the model', async () => {
    await mem.put('profile', 'me', { onboarded: true })
    const res = await runPaper({ id: '201', pmid: '201', pmcid: null, nct: null, title: null }, { cacheOnly: true })
    expect(res.error).toBeUndefined()
    await savePaper(res, {}, { source: 'digest' })
    await flush()
    expect(modelCalls.length).toBeGreaterThan(0)
  })

  it('a create-only Starter save leaves an existing paper exactly as it was', async () => {
    const mine = { id: '301', pmid: '301', saveSource: 'manual', notes: 'mine', finding: 'my reading' }
    await mem.put('papers', '301', mine)
    const res = await runPaper({ id: '301', pmid: '301', pmcid: null, nct: null, title: null }, { cacheOnly: true })
    expect(await savePaper(res, {}, { source: 'seed', modelEnrichment: false, ifAbsent: true })).toBe(null)
    expect(await mem.get('papers', '301')).toBe(mine)
    await flush()
    expect(modelCalls).toEqual([])
  })
})
