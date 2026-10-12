import { describe, expect, it } from 'vitest'
import { createContinuationTickets } from './continuationTicket.js'
import { scoreCandidatePool, rescorePool } from './digestScorePool.js'

// These drive the screen's real pool-scoring orchestration (the functions SpineCheck calls for
// "Re-rank with current rubric" and for a new scan's selection step) with dependencies that
// resolve only when the test says so. No model, no network: every dependency is a local fake.

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const PROFILE = { northStars: ['n'], rubric: { criteria: 'c', scoreFloor: 50, selectCount: 5 } }
const stub = (id, topic = 'topic') => ({ id, title: `Paper ${id}`, topics: [topic] })
// What the pool looks like on screen after an earlier scoring: old scores, reasons and roles.
const pooled = (id, score) => ({ ...stub(id), score, reason: 'old reason', selectionRole: 'score', retainedTopics: ['topic'] })
const scoredReply = (pool, score = 90) => pool.map((c, i) => ({ ...c, score: score - i, reason: 'new reason' }))
const OLD_POOL = [pooled('a', 60), pooled('b', 55)]
const OLD_CONTEXT = { counts: [{ label: 'topic', count: 2 }], failed: [], days: 3 }

// A stand-in for the screen: its state, what was saved, and every dependency call, in order.
function screen({ tickets = createContinuationTickets(), state = {} } = {}) {
  const s = {
    selecting: false, candidates: OLD_POOL, preCapCandidates: OLD_POOL, searchContext: OLD_CONTEXT,
    topicReport: 'old report', selectedIds: new Set(['a']), scoreFloor: 50, scanNote: 'old note', scanError: '',
    ...state,
  }
  const set = (key) => (value) => { s[key] = typeof value === 'function' ? value(s[key]) : value }
  const saved = []
  const calls = []
  const ui = {
    setSelecting: set('selecting'), setScanError: set('scanError'), setScanNote: set('scanNote'),
    setPreCapCandidates: set('preCapCandidates'), setSearchContext: set('searchContext'), setTopicReport: set('topicReport'),
    setCandidates: set('candidates'), setSelectedIds: set('selectedIds'), setScoreFloor: set('scoreFloor'),
  }
  const depsFor = (fakes = {}) => ({
    getProfile: async () => { calls.push('profile'); return (fakes.getProfile ?? (async () => PROFILE))() },
    digestProjects: async (profile) => { calls.push('projects'); return (fakes.digestProjects ?? (async () => []))(profile) },
    selectCandidates: async (input) => { calls.push(`select:${input.candidates.map((c) => c.id).join(',')}`); return (fakes.selectCandidates ?? (async (x) => scoredReply(x.candidates)))(input) },
  })
  const persistDigest = (overrides) => saved.push(overrides)
  // The re-rank button, as the screen calls it.
  const rescore = (fakes) => rescorePool({
    tickets,
    snapshot: { candidates: s.candidates, preCapCandidates: s.preCapCandidates, searchContext: s.searchContext, selecting: s.selecting },
    ui, persistDigest, deps: depsFor(fakes),
  })
  // A new scan's selection step, as the screen calls it: no ticket.
  const scanScore = (pool, context, fakes) => scoreCandidatePool(pool, context, { ui, persistDigest, deps: depsFor(fakes) })
  // Everything a re-score could change on screen.
  const shown = () => JSON.stringify([s.candidates, s.preCapCandidates, s.searchContext, s.topicReport, [...s.selectedIds], s.scoreFloor])
  return { s, saved, calls, tickets, rescore, scanScore, shown }
}

describe('pool scoring: uninterrupted', () => {
  it('a re-score sends one selection call for the pool without its old scores, applies and saves it', async () => {
    const { s, saved, calls, rescore } = screen()
    let sent
    const out = await rescore({ selectCandidates: async (input) => { sent = input; return scoredReply(input.candidates) } })
    expect(calls).toEqual(['profile', 'projects', 'select:a,b'])
    expect(sent.candidates).toEqual([stub('a'), stub('b')]) // old score, reason and role stripped
    expect(sent).toMatchObject({ rubric: 'c', northStars: ['n'], projects: [] })
    expect(out.blocked).toBeUndefined()
    expect(s.candidates.map((c) => [c.id, c.score, c.reason])).toEqual([['a', 90, 'new reason'], ['b', 89, 'new reason']])
    expect([...s.selectedIds]).toEqual(['a', 'b'])
    expect(s.scanNote).toBe('On title, abstract, and journal, 2 of 2 came within 20 points of your final bar of 50.')
    expect([s.selecting, s.scanError]).toEqual([false, ''])
    expect(saved).toHaveLength(1)
    expect(saved[0].candidates.map((c) => c.score)).toEqual([90, 89])
    expect([...saved[0].selectedIds]).toEqual(['a', 'b'])
  })

  it("a new scan's selection step needs no ticket and is unaffected by the gate", async () => {
    const { s, saved, calls, tickets, scanScore } = screen({ state: { candidates: [], preCapCandidates: [], selectedIds: new Set() } })
    tickets.freeze('abandoned') // a new scan is not a continuation; the screen's own entry rules decide whether it starts
    const out = await scanScore([stub('x'), stub('y')], { counts: [], failed: [], days: 1 })
    expect(calls).toEqual(['profile', 'projects', 'select:x,y'])
    expect(out.scored.map((c) => c.id)).toEqual(['x', 'y'])
    expect([...out.chosenIds]).toEqual(['x', 'y'])
    expect(out).toMatchObject({ cleared: 2, floor: 50, screeningFloor: 30 })
    expect(s.candidates.map((c) => c.id)).toEqual(['x', 'y'])
    expect(saved).toHaveLength(1)
  })

  it('a failed selection call on a live re-score says so and puts the busy flag away', async () => {
    const { s, saved, rescore, shown } = screen()
    const before = shown()
    const out = await rescore({ selectCandidates: async () => { throw new Error('boom') } })
    expect(out).toEqual({ failed: true })
    expect(s.scanError).toBe('Re-rank failed: boom')
    expect(s.selecting).toBe(false)
    expect(shown()).toBe(before)
    expect(saved).toEqual([])
  })

  it('nothing starts for a digest already held or stopped, an empty pool, or a re-score already running', async () => {
    for (const state of ['held', 'abandoned']) {
      const { s, saved, calls, tickets, rescore } = screen()
      tickets.freeze(state)
      expect(await rescore()).toEqual({ blocked: true })
      expect([calls, saved, s.scanNote, s.selecting]).toEqual([[], [], 'old note', false])
    }
    for (const state of [{ candidates: [] }, { selecting: true }]) {
      const { saved, calls, tickets, rescore } = screen({ state })
      const issued = tickets.begin()
      expect(await rescore()).toEqual({ skipped: true })
      expect([calls, saved]).toEqual([[], []])
      expect(tickets.latest(issued)).toBe(true) // a refused re-score takes no ticket
    }
  })
})

describe('pool re-score: invalidated while a step is awaited', () => {
  const invalidations = {
    held: (t) => t.freeze('held'),
    abandoned: (t) => t.freeze('abandoned'),
    replaced: (t) => t.invalidate(),
  }
  for (const [how, invalidate] of Object.entries(invalidations)) {
    it(`${how} during the profile read: no project read, no selection call, nothing applied or saved`, async () => {
      const profile = deferred()
      const { s, saved, calls, tickets, rescore, shown } = screen()
      const before = shown()
      const pending = rescore({ getProfile: () => profile.promise })
      await settle()
      expect([calls, s.selecting]).toEqual([['profile'], true])
      invalidate(tickets)
      profile.resolve(PROFILE)
      expect(await pending).toEqual({ blocked: true })
      expect(calls).toEqual(['profile'])
      expect(shown()).toBe(before)
      expect(saved).toEqual([])
      expect([s.selecting, s.scanError, s.scanNote]).toEqual([false, '', '']) // its own flag put away; no late note
    })

    it(`${how} during the project read: no selection call, nothing applied or saved`, async () => {
      const projects = deferred()
      const { s, saved, calls, tickets, rescore, shown } = screen()
      const before = shown()
      const pending = rescore({ digestProjects: () => projects.promise })
      await settle()
      expect(calls).toEqual(['profile', 'projects'])
      invalidate(tickets)
      projects.resolve([{ title: 'p' }])
      expect(await pending).toEqual({ blocked: true })
      expect(calls).toEqual(['profile', 'projects'])
      expect(shown()).toBe(before)
      expect(saved).toEqual([])
      expect(s.selecting).toBe(false)
    })

    it(`${how} while the selection reply is out: the reply is not applied and not saved`, async () => {
      const reply = deferred()
      const { s, saved, calls, tickets, rescore, shown } = screen()
      const before = shown()
      const pending = rescore({ selectCandidates: () => reply.promise })
      await settle()
      expect(calls).toEqual(['profile', 'projects', 'select:a,b']) // already sent; not undone
      invalidate(tickets)
      reply.resolve(scoredReply([stub('a'), stub('b')]))
      expect(await pending).toEqual({ blocked: true })
      expect(shown()).toBe(before)
      expect(saved).toEqual([])
      expect([s.selecting, s.scanError, s.scanNote]).toEqual([false, '', ''])
    })

    it(`${how} while the selection reply is out, and it then fails: no error from the stale re-score`, async () => {
      const reply = deferred()
      const { s, saved, tickets, rescore, shown } = screen()
      const before = shown()
      const pending = rescore({ selectCandidates: () => reply.promise })
      await settle()
      invalidate(tickets)
      reply.reject(new Error('late failure'))
      expect(await pending).toEqual({ blocked: true })
      expect(s.scanError).toBe('')
      expect(shown()).toBe(before)
      expect(saved).toEqual([])
      expect(s.selecting).toBe(false)
    })
  }
})

describe('pool re-score: a hold followed by a new scan before the old reply arrives', () => {
  // What the screen's startScan does to the tickets: clear the gate, invalidate, take ownership.
  const startNewScan = (tickets) => { tickets.clear(); tickets.invalidate(); return tickets.begin() }

  it('old re-score waiting on the profile: no selection call after the gate is cleared, and the new scan keeps its flag', async () => {
    const oldProfile = deferred()
    const newReply = deferred()
    const { s, saved, calls, tickets, rescore, scanScore } = screen()
    const oldRun = rescore({ getProfile: () => oldProfile.promise })
    await settle()
    tickets.freeze('abandoned')
    startNewScan(tickets)
    expect(tickets.blocked()).toBe(false)
    s.selecting = true // the new scan's own selection step is now running
    const newRun = scanScore([stub('n')], { counts: [], failed: [], days: 1 }, { selectCandidates: () => newReply.promise })
    await settle()
    expect(calls).toEqual(['profile', 'profile', 'projects', 'select:n'])

    oldProfile.resolve(PROFILE)
    expect(await oldRun).toEqual({ blocked: true })
    expect(calls).toEqual(['profile', 'profile', 'projects', 'select:n']) // the old re-score sent nothing more
    expect(s.selecting).toBe(true) // the new scan still owns the flag
    expect(saved).toEqual([])

    newReply.resolve(scoredReply([stub('n')]))
    const out = await newRun
    expect(out.scored.map((c) => c.id)).toEqual(['n'])
    expect(s.candidates.map((c) => c.id)).toEqual(['n'])
    expect(saved).toHaveLength(1)
    expect(saved[0].candidates.map((c) => c.id)).toEqual(['n'])
  })

  it('old selection reply arriving after the new scan scored: it does not overwrite the new pool or its save', async () => {
    const oldReply = deferred()
    const { s, saved, tickets, rescore, scanScore, shown } = screen()
    const oldRun = rescore({ selectCandidates: () => oldReply.promise })
    await settle()
    tickets.freeze('held')
    tickets.clear() // the server released the hold
    startNewScan(tickets)
    s.selecting = true
    await scanScore([stub('n')], { counts: [], failed: [], days: 1 })
    const afterNew = shown()
    expect(saved).toHaveLength(1)

    oldReply.resolve(scoredReply([stub('a'), stub('b')], 99))
    expect(await oldRun).toEqual({ blocked: true })
    expect(shown()).toBe(afterNew)
    expect(s.candidates.map((c) => c.id)).toEqual(['n'])
    expect(saved).toHaveLength(1)
    expect(s.selecting).toBe(true)
    expect(s.scanError).toBe('')
  })

  it('old selection failure arriving during the new scan: no error shown, flag left alone', async () => {
    const oldReply = deferred()
    const { s, tickets, rescore } = screen()
    const oldRun = rescore({ selectCandidates: () => oldReply.promise })
    await settle()
    tickets.freeze('abandoned')
    startNewScan(tickets)
    s.selecting = true
    oldReply.reject(new Error('late failure'))
    expect(await oldRun).toEqual({ blocked: true })
    expect([s.scanError, s.selecting]).toEqual(['', true])
  })

  it('a hold released with no new scan: the old re-score is still stale, and clears its own flag', async () => {
    const oldReply = deferred()
    const { s, saved, tickets, rescore, shown } = screen()
    const before = shown()
    const oldRun = rescore({ selectCandidates: () => oldReply.promise })
    await settle()
    tickets.freeze('held')
    tickets.clear()
    oldReply.resolve(scoredReply([stub('a'), stub('b')]))
    expect(await oldRun).toEqual({ blocked: true })
    expect(shown()).toBe(before)
    expect(saved).toEqual([])
    expect(s.selecting).toBe(false)
  })
})
