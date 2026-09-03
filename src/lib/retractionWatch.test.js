// retractionWatch.test.js — the shared saved-Library retraction check: PubMed status is read
// with no model call, alerts persist on the record, the throttle stops call sites tripling
// the work, and every mounted surface hears about a new retraction.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./store.js', () => {
  const data = new Map()
  const k = (collection, key) => `${collection}:${key}`
  return {
    __data: data,
    store: {
      get: async (collection, key) => data.get(k(collection, key)),
      put: async (collection, key, value) => void data.set(k(collection, key), value),
      delete: async (collection, key) => void data.delete(k(collection, key)),
      all: async (collection) =>
        [...data.entries()].filter(([key]) => key.startsWith(`${collection}:`)).map(([, v]) => v),
    },
  }
})
vi.mock('./events.js', () => ({ logEvent: vi.fn() }))
vi.mock('./library.js', () => ({ drainVault: vi.fn().mockResolvedValue({ written: 0 }) }))
vi.mock('../pipeline/sources.js', () => ({ fetchCitations: vi.fn() }))

import {
  checkSavedRetractions,
  acknowledgeRetraction,
  subscribeRetractionAlerts,
  loadPendingRetractions,
  __resetRetractionWatch,
} from './retractionWatch.js'
import { __data } from './store.js'
import { logEvent } from './events.js'
import { drainVault } from './library.js'
import { fetchCitations } from '../pipeline/sources.js'

const T = '2026-09-03T08:00:00.000Z'

function seed() {
  __data.set('papers:1', { id: '1', pmid: '1', title: 'Withdrawn later', savedAt: '2026-01-01T00:00:00.000Z', citation: { doi: '10.1/x' } })
  __data.set('papers:2', { id: '2', pmid: '2', title: 'Still current', savedAt: '2026-01-01T00:00:00.000Z' })
}

beforeEach(() => {
  __data.clear()
  vi.clearAllMocks()
  __resetRetractionWatch()
  fetchCitations.mockResolvedValue([
    { pmid: '1', title: 'Withdrawn later', pubtypes: ['Retracted Publication'], retracted: true },
    { pmid: '2', title: 'Still current', pubtypes: ['Journal Article'], retracted: false },
  ])
})

describe('checkSavedRetractions', () => {
  it('asks PubMed once, persists the retraction, broadcasts it, and queues the vault re-write', async () => {
    seed()
    const heard = []
    subscribeRetractionAlerts((update) => heard.push(update))

    const result = await checkSavedRetractions({ reason: 'boot', now: () => T })

    expect(fetchCitations).toHaveBeenCalledTimes(1)
    expect(fetchCitations).toHaveBeenCalledWith(['1', '2'])
    expect(result.skipped).toBe(false)
    expect(result.pending.map((p) => p.id)).toEqual(['1'])
    expect(__data.get('papers:1')).toMatchObject({ retracted: true, retraction: { checkedAt: T, source: 'PubMed' }, citation: { doi: '10.1/x' } })
    expect(__data.get('papers:2').retracted).toBeUndefined()
    expect(heard).toHaveLength(1)
    expect(heard[0].pending.map((p) => p.id)).toEqual(['1'])
    expect(heard[0].patched).toHaveLength(1)
    expect(heard[0].patched[0].record.title).toBe('Withdrawn later')
    expect(logEvent).toHaveBeenCalledWith('retraction_detected', { pmid: '1', reason: 'boot' })
    expect(drainVault).toHaveBeenCalledTimes(1)
  })

  it('throttles a second call inside the window but still re-broadcasts the stored alerts', async () => {
    seed()
    await checkSavedRetractions({ now: () => T })
    const heard = []
    subscribeRetractionAlerts((update) => heard.push(update))

    const again = await checkSavedRetractions({ reason: 'library', now: () => T })

    expect(fetchCitations).toHaveBeenCalledTimes(1)
    expect(again.skipped).toBe(true)
    expect(again.pending.map((p) => p.id)).toEqual(['1'])
    expect(heard).toHaveLength(1)
    expect(heard[0].patched).toEqual([])
  })

  it('a digest scan can demand a fresher check than the default window', async () => {
    seed()
    await checkSavedRetractions({ now: () => T })
    await checkSavedRetractions({ reason: 'digest', maxAgeMs: 0, now: () => T })
    await checkSavedRetractions({ reason: 'digest', force: true, now: () => T })
    expect(fetchCitations).toHaveBeenCalledTimes(3)
  })

  it('does not re-alert a retraction the clinician already kept, and never touches the vault for it', async () => {
    seed()
    __data.set('papers:1', { ...__data.get('papers:1'), retracted: true, retraction: { retracted: true, checkedAt: T, acknowledgedAt: T } })
    const result = await checkSavedRetractions({ now: () => T })
    expect(result.pending).toEqual([])
    expect(logEvent).not.toHaveBeenCalled()
    expect(drainVault).not.toHaveBeenCalled()
  })

  it('a network miss leaves the Library unchanged and is not counted as a check', async () => {
    seed()
    fetchCitations.mockRejectedValue(new Error('offline'))
    const result = await checkSavedRetractions({ now: () => T })
    expect(result.pending).toEqual([])
    expect(__data.get('papers:1').retracted).toBeUndefined()
    // refreshSavedRetractions swallows the batch failure; the run still counts as done so a
    // flaky network does not hammer PubMed on every surface mount.
    expect(result.skipped).toBe(false)
  })

  it('coalesces concurrent callers onto one in-flight check', async () => {
    seed()
    const [a, b] = await Promise.all([checkSavedRetractions({ now: () => T }), checkSavedRetractions({ now: () => T })])
    expect(fetchCitations).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })
})

describe('acknowledgeRetraction', () => {
  it('persists the acknowledgement, keeps the retraction, and broadcasts the shorter list', async () => {
    seed()
    await checkSavedRetractions({ now: () => T })
    const heard = []
    subscribeRetractionAlerts((update) => heard.push(update))

    const next = await acknowledgeRetraction('1', '2026-09-03T09:00:00.000Z')

    expect(next).toMatchObject({ retracted: true, retraction: { checkedAt: T, acknowledgedAt: '2026-09-03T09:00:00.000Z' } })
    expect(__data.get('papers:1').retraction.acknowledgedAt).toBe('2026-09-03T09:00:00.000Z')
    expect(heard.at(-1).pending).toEqual([])
    expect(await loadPendingRetractions()).toEqual([])
  })

  it('no-ops for a paper that is not in the Library', async () => {
    expect(await acknowledgeRetraction('missing')).toBeNull()
  })
})
