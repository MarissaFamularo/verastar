import { describe, it, expect, vi } from 'vitest'
import { specialtySlug, pickSeedRows, seedDue, pendingPicks, nextSeedState, retryDelayMs, seedLibraryIfDue, SEED_RETRY_MS, SEED_RETRY_MAX_MS, SEED_STATE_KEY } from './seed.js'

describe('specialtySlug', () => {
  it('maps clinician self-descriptions onto the reference shelves', () => {
    expect(specialtySlug("I'm a vascular surgeon")).toBe('vascular-surgery')
    expect(specialtySlug('interventional cardiologist')).toBe('cardiology')
    expect(specialtySlug('general surgery resident')).toBe('general-surgery')
    expect(specialtySlug('nephrology')).toBe('general')
    expect(specialtySlug('')).toBe('general')
  })
})

describe('pickSeedRows', () => {
  const rows = [
    { specialty: 'general', pmid: '1', rank: 1 },
    { specialty: 'vascular-surgery', pmid: '2', rank: 2 },
    { specialty: 'vascular-surgery', pmid: '3', rank: 1 },
    { specialty: 'cardiology', pmid: '4', rank: 1 },
    { specialty: 'general', pmid: '3', rank: 5 }, // duplicate pmid across shelves
  ]
  it('takes the own shelf by rank, then general, without duplicates', () => {
    expect(pickSeedRows(rows, 'vascular-surgery').map((r) => r.pmid)).toEqual(['3', '2', '1'])
  })
  it('caps the total', () => {
    expect(pickSeedRows(rows, 'vascular-surgery', 2).map((r) => r.pmid)).toEqual(['3', '2'])
  })
  it('a general reader gets only the general shelf', () => {
    expect(pickSeedRows(rows, 'general').map((r) => r.pmid)).toEqual(['1', '3'])
  })
})

describe('seedDue', () => {
  const base = { signedIn: true, configured: true, profile: { onboarded: true }, seed: null, paperCount: 0, now: Date.parse('2026-10-09T12:00:00Z') }
  it('runs only for a signed-in onboarded account, until its record says complete', () => {
    expect(seedDue(base)).toBe(true)
    expect(seedDue({ ...base, signedIn: false })).toBe(false)
    expect(seedDue({ ...base, profile: { onboarded: true, demo: true } })).toBe(false)
    expect(seedDue({ ...base, profile: { onboarded: false } })).toBe(false)
    expect(seedDue({ ...base, seed: { startedAt: 'x', completedAt: 'y' } })).toBe(false)
  })
  it('a legacy seededAt stamp on an empty library is not completion', () => {
    expect(seedDue({ ...base, profile: { onboarded: true, seededAt: '2026-09-20T00:00:00Z' } })).toBe(true)
  })
  it('a never-started library with papers is left alone; a started run resumes', () => {
    expect(seedDue({ ...base, paperCount: 4, profile: { onboarded: true, seededAt: '2026-09-20T00:00:00Z' } })).toBe(false)
    expect(seedDue({ ...base, paperCount: 3, seed: { startedAt: 'x' } })).toBe(true)
  })
  it('waits out the cooldown', () => {
    expect(seedDue({ ...base, seed: { startedAt: 'x', nextAttemptAt: new Date(base.now + 60_000).toISOString() } })).toBe(false)
    expect(seedDue({ ...base, seed: { startedAt: 'x', nextAttemptAt: new Date(base.now - 60_000).toISOString() } })).toBe(true)
  })
})

describe('pendingPicks / nextSeedState / backoff', () => {
  const picks = [{ pmid: '1' }, { pmid: '2' }, { pmid: '3' }]
  const now = Date.parse('2026-10-09T12:00:00Z')
  it('skips done, removed, and already-saved papers', () => {
    expect(pendingPicks(picks, { done: ['1'], removed: ['2'] }, new Set()).map((r) => r.pmid)).toEqual(['3'])
    expect(pendingPicks(picks, {}, new Set(['3'])).map((r) => r.pmid)).toEqual(['1', '2'])
  })
  it('a failed or empty reference query never completes', () => {
    expect(nextSeedState({}, { queryOk: false, picks: [], now }).completedAt).toBe(null)
    const empty = nextSeedState({}, { queryOk: true, picks: [], now })
    expect(empty.completedAt).toBe(null)
    expect(Date.parse(empty.nextAttemptAt)).toBe(now + SEED_RETRY_MS)
  })
  it('completes only when every pick is saved, present, or removed by the reader', () => {
    const partial = nextSeedState({}, { queryOk: true, picks, outcomes: { 1: 'saved', 2: 'removed', 3: 'failed' }, now })
    expect(partial.completedAt).toBe(null)
    expect(partial.failures).toEqual({ 3: 1 })
    const done = nextSeedState(partial, { queryOk: true, picks, outcomes: { 3: 'present' }, now })
    expect(done.completedAt).toBe(new Date(now).toISOString())
    expect(done.failures).toEqual({})
    expect(done.incompleteRuns).toBe(0)
  })
  it('repeated temporary failures back off but never become completion', () => {
    let s = {}
    for (let i = 0; i < 12; i++) s = nextSeedState(s, { queryOk: true, picks: [{ pmid: '9' }], outcomes: { 9: 'failed' }, now })
    expect(s.completedAt).toBe(null)
    expect(s.failures).toEqual({ 9: 12 })
    expect(Date.parse(s.nextAttemptAt) - now).toBe(SEED_RETRY_MAX_MS)
    expect(retryDelayMs(1)).toBe(SEED_RETRY_MS)
    expect(retryDelayMs(2)).toBe(2 * SEED_RETRY_MS)
    expect(retryDelayMs(50)).toBe(SEED_RETRY_MAX_MS)
  })
})

// A shared in-memory account. Profile 'me' and the seed record are separate keys, as in the
// kv table. Papers obey the cloud create contract: create on an existing key conflicts, and a
// removed (tombstoned) key refuses a non-restoring create.
function account({ profile, papers = [], rows = [], queryError = false, failPmids = [], removed = [] } = {}) {
  const kv = new Map([['profile/me', { onboarded: true, specialty: 'vascular-surgery', ...profile }]])
  for (const p of papers) kv.set(`papers/${p.id}`, p)
  const calls = { runPaper: [], savePaper: [], events: [], seedWrites: 0 }
  let clock = Date.parse('2026-10-09T12:00:00Z')
  const hooks = { beforeSeedWrite: null, afterRun: null }
  const deps = {
    configured: true,
    signedIn: true,
    locks: null,
    lockName: 'seed:test',
    now: () => clock,
    getProfile: async () => kv.get('profile/me'),
    getSeedState: async () => kv.get(`profile/${SEED_STATE_KEY}`),
    putSeedState: async (v) => { calls.seedWrites++; if (hooks.beforeSeedWrite) await hooks.beforeSeedWrite(); kv.set(`profile/${SEED_STATE_KEY}`, v) },
    listPapers: async () => [...kv.entries()].filter(([k]) => k.startsWith('papers/')).map(([, v]) => v),
    getPaper: async (id) => kv.get(`papers/${id}`),
    fetchReferenceRows: async () => { if (queryError) throw new Error('network'); return rows },
    runPaper: async (paper, opts) => {
      calls.runPaper.push({ pmid: paper.pmid, opts })
      await new Promise((r) => setTimeout(r, 1))
      if (hooks.afterRun) await hooks.afterRun(paper)
      if (failPmids.includes(paper.pmid)) return { paper, error: 'Not in the shared evidence cache yet.' }
      return { paper, citation: { title: `Paper ${paper.pmid}` } }
    },
    savePaper: async (res, take, opts) => {
      const key = `papers/${res.paper.id}`
      calls.savePaper.push({ pmid: res.paper.pmid, opts })
      if (removed.includes(res.paper.pmid)) throw new Error('This paper was removed from the Library. The pending change was not saved.')
      if (kv.has(key)) {
        if (opts.ifAbsent) return null
        throw new Error('This paper changed in another tab. Reload and reapply your edit; your edit was not saved.')
      }
      const rec = { id: res.paper.id, pmid: res.paper.pmid, saveSource: opts.source }
      kv.set(key, rec)
      return rec
    },
    logEvent: (type, payload) => calls.events.push({ type, payload }),
  }
  return { kv, calls, deps, hooks, advance: (ms) => { clock += ms }, papers: () => [...kv.keys()].filter((k) => k.startsWith('papers/')).map((k) => k.slice(7)).sort() }
}
const shelf = [
  { specialty: 'vascular-surgery', pmid: '11', rank: 1 },
  { specialty: 'vascular-surgery', pmid: '12', rank: 2 },
  { specialty: 'general', pmid: '13', rank: 1 },
]

describe('seedLibraryIfDue — the runner', () => {
  it('saves every starter create-only, with paid enrichment off, never restoring a removed one', async () => {
    const a = account({ rows: shelf, removed: ['13'] })
    expect(await seedLibraryIfDue({ deps: a.deps })).toEqual({ seeded: 2, skipped: 1, complete: true })
    expect(a.calls.runPaper.every((c) => c.opts.cacheOnly === true)).toBe(true)
    expect(a.calls.savePaper.every((c) => c.opts.modelEnrichment === false && c.opts.restoreDeleted === false && c.opts.ifAbsent === true && c.opts.source === 'seed')).toBe(true)
    expect(a.kv.get(`profile/${SEED_STATE_KEY}`)).toMatchObject({ removed: ['13'], specialty: 'vascular-surgery' })
    expect(a.papers()).toEqual(['11', '12'])
  })

  it('never writes the steering profile: an edit interleaved with each seed write survives', async () => {
    const a = account({ rows: shelf, profile: { northStars: ['original'] } })
    let n = 0
    a.hooks.beforeSeedWrite = async () => { n++; a.kv.set('profile/me', { ...a.kv.get('profile/me'), northStars: [`concurrent edit ${n}`] }) }
    const before = a.kv.get('profile/me')
    await seedLibraryIfDue({ deps: a.deps })
    expect(a.calls.seedWrites).toBe(2)
    expect(a.kv.get('profile/me').northStars).toEqual(['concurrent edit 2'])
    expect(a.kv.get('profile/me').seed).toBeUndefined()
    expect(a.kv.get('profile/me').seededAt).toBeUndefined()
    expect(Object.keys(a.kv.get('profile/me')).sort()).toEqual(Object.keys(before).sort())
  })

  it('a failed reference query leaves seeding open; the next app open after the cooldown fills it', async () => {
    const a = account({ queryError: true })
    expect(await seedLibraryIfDue({ deps: a.deps })).toEqual({ seeded: 0, skipped: 0, complete: false })
    expect(await seedLibraryIfDue({ deps: a.deps })).toBe(null) // re-render inside the cooldown
    a.advance(SEED_RETRY_MS + 1)
    expect((await seedLibraryIfDue({ deps: { ...a.deps, fetchReferenceRows: async () => shelf } })).complete).toBe(true)
    expect(a.papers()).toEqual(['11', '12', '13'])
  })

  it('recovers an account the old seeder stamped complete on an empty shelf', async () => {
    const a = account({ profile: { seededAt: '2026-09-20T00:00:00Z' }, rows: shelf })
    expect((await seedLibraryIfDue({ deps: a.deps })).seeded).toBe(3)
  })

  it('a temporary failure recovers after more than three attempts', async () => {
    const a = account({ rows: [shelf[0]], failPmids: ['11'] })
    for (let i = 0; i < 5; i++) {
      expect((await seedLibraryIfDue({ deps: a.deps })).complete).toBe(false)
      a.advance(SEED_RETRY_MAX_MS + 1)
    }
    expect(a.kv.get(`profile/${SEED_STATE_KEY}`).failures).toEqual({ 11: 5 })
    const cached = { ...a.deps, runPaper: async (paper) => ({ paper, citation: {} }) }
    expect(await seedLibraryIfDue({ deps: cached })).toEqual({ seeded: 1, skipped: 0, complete: true })
    expect(a.papers()).toEqual(['11'])
  })

  it('resumes an interrupted run without duplicating or touching saved papers', async () => {
    const mine = { id: '12', pmid: '12', saveSource: 'manual', notes: 'my own copy' }
    const a = account({ rows: shelf, papers: [{ id: '11', pmid: '11', saveSource: 'seed' }, mine] })
    a.kv.set(`profile/${SEED_STATE_KEY}`, { startedAt: '2026-10-09T11:00:00Z', done: ['11'] })
    expect(await seedLibraryIfDue({ deps: a.deps })).toEqual({ seeded: 1, skipped: 0, complete: true })
    expect(a.calls.runPaper.map((c) => c.pmid)).toEqual(['13'])
    expect(a.kv.get('papers/12')).toBe(mine)
  })

  it('a paper the reader saves mid-run is not overwritten', async () => {
    const a = account({ rows: [shelf[0]] })
    const mine = { id: '11', pmid: '11', saveSource: 'digest' }
    a.hooks.afterRun = async () => { a.kv.set('papers/11', mine) }
    expect((await seedLibraryIfDue({ deps: a.deps })).complete).toBe(true)
    expect(a.kv.get('papers/11')).toBe(mine)
  })

  it('two independent runners without a lock (other device / no Web Locks) stay idempotent', async () => {
    vi.resetModules()
    const one = await import('./seed.js?runner=one')
    vi.resetModules()
    const two = await import('./seed.js?runner=two')
    expect(one.seedLibraryIfDue).not.toBe(two.seedLibraryIfDue)
    const a = account({ rows: shelf, papers: [{ id: '12', pmid: '12', saveSource: 'manual' }] })
    a.kv.set(`profile/${SEED_STATE_KEY}`, { startedAt: '2026-10-09T11:00:00Z' }) // an interrupted run, resumed on two devices
    const mine = a.kv.get('papers/12')
    const [r1, r2] = await Promise.all([one.seedLibraryIfDue({ deps: a.deps }), two.seedLibraryIfDue({ deps: a.deps })])
    // Both ran; every paper exists exactly once, the reader's copy is untouched, nothing was
    // reported as failed, and the record converges to complete.
    expect(r1).not.toBe(null)
    expect(r2).not.toBe(null)
    expect(a.papers()).toEqual(['11', '12', '13'])
    expect(a.kv.get('papers/12')).toBe(mine)
    expect(r1.seeded + r2.seeded).toBe(2)
    expect(r1.skipped + r2.skipped).toBe(0)
    const rec = a.kv.get(`profile/${SEED_STATE_KEY}`)
    expect(rec.completedAt).toBeTruthy()
    expect(rec.failures).toEqual({})
  })

  it('two independent runners with a Web Lock: the second is excluded', async () => {
    vi.resetModules()
    const one = await import('./seed.js?runner=three')
    vi.resetModules()
    const two = await import('./seed.js?runner=four')
    // Minimal Web Locks: ifAvailable grants null while the name is held.
    const held = new Set()
    const locks = {
      async request(name, opts, cb) {
        if (held.has(name)) return cb(null)
        held.add(name)
        try { return await cb({ name }) } finally { held.delete(name) }
      },
    }
    const a = account({ rows: shelf })
    const deps = { ...a.deps, locks }
    const [r1, r2] = await Promise.all([one.seedLibraryIfDue({ deps }), two.seedLibraryIfDue({ deps })])
    expect([r1, r2].filter(Boolean)).toHaveLength(1)
    expect(a.calls.runPaper).toHaveLength(3)
    expect(a.papers()).toEqual(['11', '12', '13'])
  })

  it('calls in one module share the one in-flight run', async () => {
    const a = account({ rows: shelf })
    const spy = vi.fn(a.deps.fetchReferenceRows)
    const deps = { ...a.deps, fetchReferenceRows: spy }
    const [x, y] = await Promise.all([seedLibraryIfDue({ deps }), seedLibraryIfDue({ deps })])
    expect(x).toBe(y)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
