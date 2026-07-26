// favorites.test.js — locks the favorite flag's contract: it lives on the saved paper
// record, flips in place without touching any other field, and quietly no-ops for a
// paper that isn't in the Library (the digest saves first, then flips).

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

import { setPaperFavorite, togglePaperFavorite } from './favorites.js'
import { __data } from './store.js'
import { logEvent } from './events.js'

const paper = () => ({ id: 'p1', pmid: '111', title: 'A paper', tags: ['x'], notes: 'keep me' })

beforeEach(() => {
  __data.clear()
  vi.clearAllMocks()
})

describe('setPaperFavorite', () => {
  it('sets the flag and leaves every other field alone', async () => {
    __data.set('papers:p1', paper())
    const next = await setPaperFavorite('p1', true)
    expect(next.favorite).toBe(true)
    expect(next.notes).toBe('keep me')
    expect(next.tags).toEqual(['x'])
    expect(__data.get('papers:p1').favorite).toBe(true)
  })

  it('returns null (and writes nothing) for a paper not in the Library', async () => {
    const res = await setPaperFavorite('ghost', true)
    expect(res).toBeNull()
    expect(__data.size).toBe(0)
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('logs the heart as a telemetry event with the pmid and surface', async () => {
    __data.set('papers:p1', paper())
    await setPaperFavorite('p1', true, { surface: 'digest' })
    expect(logEvent).toHaveBeenCalledWith('paper_favorited', { pmid: '111', favorite: true, surface: 'digest' })
  })

  it('logs surface "unknown" when a call site forgets to say where', async () => {
    __data.set('papers:p1', paper())
    await setPaperFavorite('p1', true)
    expect(logEvent).toHaveBeenCalledWith('paper_favorited', { pmid: '111', favorite: true, surface: 'unknown' })
  })
})

describe('togglePaperFavorite', () => {
  it('flips off → on → off', async () => {
    __data.set('papers:p1', paper())
    expect((await togglePaperFavorite('p1')).favorite).toBe(true)
    expect((await togglePaperFavorite('p1')).favorite).toBe(false)
  })

  it('treats a record that predates the flag as un-favorited', async () => {
    __data.set('papers:p1', paper()) // no favorite key at all
    const next = await togglePaperFavorite('p1')
    expect(next.favorite).toBe(true)
  })
})
