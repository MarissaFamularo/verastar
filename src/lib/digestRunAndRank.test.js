import { describe, expect, it } from 'vitest'
import { createContinuationGate } from './digestStore.js'
import { createContinuationTickets } from './continuationTicket.js'
import { rankingFailureNote, runAndRankDigest } from './digestRunAndRank.js'

// These drive the screen's real read-then-rank orchestration (the function SpineCheck calls)
// with dependencies that resolve only when the test says so, so a hold can land in the
// middle of each await. No model, no network: every dependency is a local fake.

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Let every already-resolved promise continuation run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const paper = (id) => ({ id, title: `Paper ${id}`, topics: ['topic'] })
const read = (id, extra = {}) => ({ paper: paper(id), design: 'RCT', rows: [], error: null, ...extra })
const ranking = (id, score = 80) => ({ id, score, tier: 'read', finding: `finding ${id}`, relevance: `relevance ${id}` })
const PROFILE = { northStars: ['n'], rubric: { criteria: 'c', scoreFloor: 50 } }

// A stand-in for the screen: its state, what was saved, and every dependency call, in order.
function screen({ tickets = createContinuationTickets(), state = {} } = {}) {
  const s = {
    running: false, ranking: false, restored: 'restored', results: [], processedResults: [], triaged: {},
    stages: {}, expanded: {}, capNotice: '', selectedIds: new Set(), scoreFloor: null, scanNote: '', scanError: '',
    ...state,
  }
  const set = (key) => (value) => { s[key] = typeof value === 'function' ? value(s[key]) : value }
  const saved = []
  const calls = []
  const events = []
  const ui = {
    setRunning: set('running'), setRanking: set('ranking'), setRestored: set('restored'), setResults: set('results'),
    setProcessedResults: set('processedResults'), setStages: set('stages'), setTriaged: set('triaged'),
    setExpanded: set('expanded'), setCapNotice: set('capNotice'), setSelectedIds: set('selectedIds'),
    setScoreFloor: set('scoreFloor'), setScanNote: set('scanNote'), setScanError: set('scanError'),
  }
  // Each run gets its own dependency fakes, sharing this screen and its tickets.
  function run(papers, options = {}, fakes = {}) {
    const deps = {
      runPaper: async (p, opts) => { calls.push(`paper:${p.id}`); return (fakes.runPaper ?? (async (x) => read(x.id)))(p, opts) },
      getProfile: async () => { calls.push('profile'); return (fakes.getProfile ?? (async () => PROFILE))() },
      digestProjects: async (profile) => { calls.push('projects'); return (fakes.digestProjects ?? (async () => []))(profile) },
      triage: async (input) => { calls.push(`triage:${input.candidates.map((c) => c.id).join(',')}`); return (fakes.triage ?? (async (x) => x.candidates.map((c) => ranking(c.id))))(input) },
      logEvent: (name, data) => events.push({ name, data }),
    }
    return runAndRankDigest(papers, options, {
      tickets,
      snapshot: { results: s.results, processedResults: s.processedResults, triaged: s.triaged },
      ui,
      onBegin: () => calls.push('begin'),
      persistDigest: (overrides) => saved.push(overrides),
      titleOf: (r) => r.paper.title,
      deps,
    })
  }
  return { s, saved, calls, events, tickets, run }
}

// A digest with two papers read and nothing ranked: what "Finish this digest" continues.
const unranked = () => ({ results: [read('a'), read('b')], processedResults: [read('a'), read('b')] })

describe('continuation tickets', () => {
  it('keeps the gate interface and issues a ticket only while nothing is frozen', () => {
    const t = createContinuationTickets()
    expect([t.blocked(), t.state()]).toEqual([false, null])
    const ticket = t.begin()
    expect(t.valid(ticket)).toBe(true)
    t.freeze('held')
    expect([t.blocked(), t.state(), t.begin(), t.valid(ticket)]).toEqual([true, 'held', null, false])
    t.freeze('pending') // not a frozen state: the gate lifts, the old ticket stays stale
    expect([t.blocked(), t.valid(ticket)]).toEqual([false, false])
    expect(t.valid(null)).toBe(false)
  })

  it('a ticket invalidated by a hold is not revived when the gate is cleared', () => {
    const gate = createContinuationGate()
    const t = createContinuationTickets(gate)
    const old = t.begin()
    t.freeze('abandoned')
    t.clear()
    expect(gate.blocked()).toBe(false)
    expect(t.valid(old)).toBe(false)
    const next = t.begin()
    expect([t.valid(next), t.latest(next), t.latest(old)]).toEqual([true, true, false])
  })

  it('a replaced screen invalidates without freezing', () => {
    const t = createContinuationTickets()
    const old = t.begin()
    t.invalidate()
    expect([t.blocked(), t.valid(old), t.latest(old)]).toEqual([false, false, true])
  })
})

describe('runAndRankDigest: an uninterrupted run is unchanged', () => {
  it('reads each paper, saves after each, ranks once, applies and saves the ranked digest', async () => {
    const { s, saved, calls, events, run } = screen()
    const out = await run([paper('a'), paper('b')])
    expect(calls).toEqual(['begin', 'paper:a', 'paper:b', 'profile', 'projects', 'triage:a,b'])
    expect(out.blocked).toBeUndefined()
    expect(out.outcomes).toEqual([{ id: 'a', error: null }, { id: 'b', error: null }])
    expect(s.results.map((r) => r.paper.id)).toEqual(['a', 'b'])
    expect(Object.keys(s.triaged)).toEqual(['a', 'b'])
    expect([s.running, s.ranking, s.restored, s.scanError]).toEqual([false, false, null, ''])
    expect(s.scanNote).toBe('After reading, all 2 cleared your bar of 50.')
    expect(saved).toHaveLength(3) // one per paper, one after ranking
    expect(Object.keys(saved[2].triaged)).toEqual(['a', 'b'])
    expect(events.map((e) => e.name)).toEqual(['digest_run'])
  })

  it('Finish on an unranked digest reads nothing again and ranks the whole set', async () => {
    const { s, saved, calls, run } = screen({ state: unranked() })
    const out = await run([paper('a'), paper('b')], { append: true })
    expect(calls).toEqual(['begin', 'profile', 'projects', 'triage:a,b'])
    expect(Object.keys(out.triaged)).toEqual(['a', 'b'])
    expect(Object.keys(s.triaged)).toEqual(['a', 'b'])
    expect(saved).toHaveLength(1)
  })

  it('a ranking retry that read nothing does not say zero papers were read, and success clears the banner', async () => {
    const cap = 'You have read a lot today. New papers pick up tomorrow morning. Everything already in your library still works.'
    expect(rankingFailureNote({ append: true, added: 0, message: cap })).not.toMatch(/0 added|\.\./)
    expect(rankingFailureNote({ append: true, added: 0, message: cap })).toContain(cap.replace(/\.$/, ''))
    const failed = screen({ state: { ...unranked(), scanError: 'old banner' } })
    await failed.run([paper('a'), paper('b')], { append: true }, { triage: async () => { throw new Error(cap) } })
    expect(failed.s.scanError).toBe(rankingFailureNote({ append: true, added: 0, message: cap }))
    expect(failed.s.results.map((r) => r.paper.id)).toEqual(['a', 'b'])
    const again = screen({ state: { ...unranked(), scanError: failed.s.scanError } })
    await again.run([paper('a'), paper('b')], { append: true })
    expect(again.s.scanError).toBe('')
    expect(again.s.results.map((r) => r.paper.id)).toEqual(['a', 'b'])
  })

  it('a paper under the bar stays in the list', async () => {
    const { s, run } = screen()
    await run([paper('a'), paper('b')], {}, {
      triage: async () => [ranking('a', 80), ranking('b', 10)],
    })
    expect(s.results.map((r) => r.paper.id)).toEqual(['a', 'b'])
    expect(s.scanNote).toMatch(/below that bar and stay in the list/)
  })

  it('a ranking failure on a live run still says so and keeps the reading', async () => {
    const { s, saved, run } = screen()
    const out = await run([paper('a')], {}, { triage: async () => { throw new Error('boom') } })
    expect(out.blocked).toBeUndefined()
    expect(s.scanError).toContain('could not finish their summaries: boom')
    expect([s.running, s.ranking]).toEqual([false, false])
    expect(saved).toHaveLength(2)
  })

  it('nothing starts for a digest already held or stopped', async () => {
    for (const state of ['held', 'abandoned']) {
      const { s, saved, calls, tickets, run } = screen({ state: unranked() })
      tickets.freeze(state)
      const out = await run([paper('a'), paper('c')], { append: true })
      expect(out).toMatchObject({ blocked: true, outcomes: [] })
      expect(calls).toEqual([])
      expect(saved).toEqual([])
      expect(s.restored).toBe('restored')
    }
  })
})

describe('runAndRankDigest: found held while a step is awaited', () => {
  it('held during the profile read: no project read, no ranking call, nothing applied or saved', async () => {
    const profile = deferred()
    const { s, saved, calls, events, tickets, run } = screen({ state: unranked() })
    const pending = run([paper('a'), paper('b')], { append: true }, { getProfile: () => profile.promise })
    await settle()
    expect(calls).toEqual(['begin', 'profile'])
    tickets.freeze('held')
    profile.resolve(PROFILE)
    const out = await pending
    expect(calls).toEqual(['begin', 'profile']) // the reviewer's reproduction sent one ranking call here
    expect(out).toMatchObject({ blocked: true, outcomes: [], post: null })
    expect(s.triaged).toEqual({})
    expect(saved).toEqual([])
    expect(events).toEqual([])
    expect([s.running, s.ranking, s.scanError]).toEqual([false, false, ''])
  })

  it('held during the project read: no ranking call, nothing applied or saved', async () => {
    const projects = deferred()
    const { s, saved, calls, tickets, run } = screen({ state: unranked() })
    const pending = run([paper('a'), paper('b')], { append: true }, { digestProjects: () => projects.promise })
    await settle()
    expect(calls).toEqual(['begin', 'profile', 'projects'])
    tickets.freeze('held')
    projects.resolve([{ title: 'p' }])
    const out = await pending
    expect(calls).toEqual(['begin', 'profile', 'projects'])
    expect(out.blocked).toBe(true)
    expect(s.triaged).toEqual({})
    expect(saved).toEqual([])
    expect(s.ranking).toBe(false)
  })

  it('held during a paper call: its result is discarded, no later paper is read, no ranking', async () => {
    const second = deferred()
    const { s, saved, calls, events, tickets, run } = screen()
    const pending = run([paper('a'), paper('b'), paper('c')], {}, {
      runPaper: (p) => (p.id === 'b' ? second.promise : Promise.resolve(read(p.id))),
    })
    await settle()
    expect(calls).toEqual(['begin', 'paper:a', 'paper:b'])
    expect(saved).toHaveLength(1) // paper a, read and saved before the hold
    tickets.freeze('held')
    second.resolve(read('b'))
    const out = await pending
    expect(calls).toEqual(['begin', 'paper:a', 'paper:b']) // no paper c, no profile, no ranking
    expect(out).toMatchObject({ blocked: true, outcomes: [] })
    expect(s.results.map((r) => r.paper.id)).toEqual(['a']) // b never reached the screen
    expect(s.processedResults.map((r) => r.paper.id)).toEqual(['a'])
    expect(saved).toHaveLength(1) // and was never saved
    expect(events).toEqual([])
    expect(s.running).toBe(false)
  })

  it('held during a paper call that then reports the spending cap: no cap notice from the stale run', async () => {
    const first = deferred()
    const { s, events, tickets, run } = screen()
    const pending = run([paper('a')], {}, { runPaper: () => first.promise })
    await settle()
    tickets.freeze('held')
    first.resolve(read('a', { error: 'cap', errorObject: { capReached: true } }))
    expect((await pending).blocked).toBe(true)
    expect(s.capNotice).toBe('')
    expect(events).toEqual([])
  })

  it('held during ranking: the ranking that comes back is not applied and not saved', async () => {
    const rank = deferred()
    const { s, saved, calls, events, tickets, run } = screen({ state: unranked() })
    const pending = run([paper('a'), paper('b')], { append: true }, { triage: () => rank.promise })
    await settle()
    expect(calls).toEqual(['begin', 'profile', 'projects', 'triage:a,b']) // already sent; not undone
    expect(s.ranking).toBe(true)
    tickets.freeze('held')
    rank.resolve([ranking('a'), ranking('b')])
    const out = await pending
    expect(out).toMatchObject({ blocked: true, outcomes: [], triaged: {} })
    expect(s.triaged).toEqual({})
    expect(s.selectedIds.size).toBe(0)
    expect([s.scoreFloor, s.scanNote, s.ranking]).toEqual([null, '', false])
    expect(saved).toEqual([])
    expect(events).toEqual([])
  })

  it('held during ranking that then fails: no error message from the stale run', async () => {
    const rank = deferred()
    const { s, saved, tickets, run } = screen({ state: unranked() })
    const pending = run([paper('a')], { append: true }, { triage: () => rank.promise })
    await settle()
    tickets.freeze('held')
    rank.reject(new Error('late failure'))
    expect((await pending).blocked).toBe(true)
    expect(s.scanError).toBe('')
    expect(saved).toEqual([])
  })

  it('abandoned behaves the same as held at every boundary', async () => {
    for (const boundary of ['getProfile', 'digestProjects', 'triage']) {
      const gate = deferred()
      const { s, saved, calls, tickets, run } = screen({ state: unranked() })
      const pending = run([paper('a')], { append: true }, { [boundary]: () => gate.promise })
      await settle()
      const sent = [...calls]
      tickets.freeze('abandoned')
      gate.resolve(boundary === 'getProfile' ? PROFILE : boundary === 'triage' ? [ranking('a')] : [])
      expect((await pending).blocked).toBe(true)
      expect(calls).toEqual(sent)
      expect(s.triaged).toEqual({})
      expect(saved).toEqual([])
    }
  })

  it('a stage label from a stale paper read is not shown', async () => {
    const first = deferred()
    let onStage
    const { s, tickets, run } = screen()
    const pending = run([paper('a')], {}, { runPaper: (p, opts) => { onStage = opts.onStage; onStage(p.id, 'extract'); return first.promise } })
    await settle()
    expect(s.stages).toEqual({ a: 'extract' })
    tickets.freeze('held')
    onStage('a', 'verify') // the read is still going and reports progress
    first.resolve(read('a'))
    await pending
    expect(s.stages).toEqual({ a: 'extract' })
  })
})

describe('runAndRankDigest: a hold followed by a new scan before the old result arrives', () => {
  it('the old run stays stale after the gate is cleared: no dispatch, nothing applied, nothing saved', async () => {
    const oldProfile = deferred()
    const newPaper = deferred()
    const { s, saved, calls, events, tickets, run } = screen({ state: unranked() })
    const oldRun = run([paper('a'), paper('b')], { append: true }, { getProfile: () => oldProfile.promise })
    await settle()
    tickets.freeze('abandoned') // the digest is stopped while the old run waits on the profile
    // She starts a new scan: the screen's startScan clears the gate and invalidates.
    tickets.clear()
    tickets.invalidate()
    expect(tickets.blocked()).toBe(false)
    const newRun = run([paper('n')], {}, { runPaper: () => newPaper.promise })
    await settle()
    expect(calls).toEqual(['begin', 'profile', 'begin', 'paper:n'])
    expect(s.running).toBe(true)

    oldProfile.resolve(PROFILE) // the old run's read arrives while the new scan is reading
    const oldOut = await oldRun
    expect(oldOut.blocked).toBe(true)
    expect(calls).toEqual(['begin', 'profile', 'begin', 'paper:n']) // no project read, no ranking call
    expect(s.running).toBe(true) // the new scan still owns the busy flags
    expect(saved).toEqual([])

    newPaper.resolve(read('n'))
    const newOut = await newRun
    expect(newOut.blocked).toBeUndefined()
    expect(calls.slice(4)).toEqual(['profile', 'projects', 'triage:n'])
    expect(s.results.map((r) => r.paper.id)).toEqual(['n'])
    expect(Object.keys(s.triaged)).toEqual(['n'])
    expect(saved.every((w) => w.results.every((r) => r.paper.id === 'n'))).toBe(true)
    expect(events.map((e) => e.name)).toEqual(['digest_run'])
    expect([s.running, s.ranking]).toEqual([false, false])
  })

  it('an old ranking that arrives during the new scan is discarded and leaves the new scan intact', async () => {
    const oldRank = deferred()
    const newRank = deferred()
    const { s, saved, calls, tickets, run } = screen({ state: unranked() })
    const oldRun = run([paper('a'), paper('b')], { append: true }, { triage: () => oldRank.promise })
    await settle()
    tickets.freeze('abandoned')
    tickets.clear()
    tickets.invalidate()
    const newRun = run([paper('n')], {}, { triage: () => newRank.promise })
    await settle()
    expect(calls.slice(-4)).toEqual(['paper:n', 'profile', 'projects', 'triage:n'])
    const savedByNew = saved.length
    expect(s.ranking).toBe(true)

    oldRank.resolve([ranking('a'), ranking('b')])
    expect((await oldRun).blocked).toBe(true)
    expect(s.triaged).toEqual({}) // the old ranking never reached the screen
    expect(s.results.map((r) => r.paper.id)).toEqual(['n'])
    expect(s.ranking).toBe(true) // still the new scan's
    expect(saved).toHaveLength(savedByNew)

    newRank.resolve([ranking('n')])
    await newRun
    expect(Object.keys(s.triaged)).toEqual(['n'])
    expect(Object.keys(saved.at(-1).triaged)).toEqual(['n'])
  })

  it('an old paper read that arrives after the server released the hold is still discarded', async () => {
    // Held, then the gate lifts with no new scan from this screen (the server took the run).
    const oldPaper = deferred()
    const { s, saved, calls, tickets, run } = screen()
    const oldRun = run([paper('a'), paper('b')], {}, { runPaper: () => oldPaper.promise })
    await settle()
    tickets.freeze('held')
    tickets.clear()
    oldPaper.resolve(read('a'))
    expect((await oldRun).blocked).toBe(true)
    expect(calls).toEqual(['begin', 'paper:a'])
    expect(s.results).toEqual([])
    expect(saved).toEqual([])
  })

  it('a different stored digest shown mid-run invalidates the run without any hold', async () => {
    const rank = deferred()
    const { s, saved, tickets, run } = screen({ state: unranked() })
    const pending = run([paper('a')], { append: true }, { triage: () => rank.promise })
    await settle()
    tickets.invalidate() // showSaved put another digest on screen
    rank.resolve([ranking('a')])
    expect((await pending).blocked).toBe(true)
    expect(s.triaged).toEqual({})
    expect(saved).toEqual([])
    expect(s.ranking).toBe(false) // no later run owns the flag, so the stale run puts it away
  })
})

it('pilot: a fresh browser digest reads and ranks at most twenty papers', async () => {
  const x = screen()
  const papers = Array.from({ length: 25 }, (_, i) => paper(String(i)))
  const out = await x.run(papers)
  expect(out.processedResults).toHaveLength(20)
  expect(x.calls.filter((c) => c.startsWith('paper:'))).toHaveLength(20)
  expect(x.s.capNotice).toContain('20 papers')
})
it('pilot: additions share the original allowance and a full digest makes no extra calls', async () => {
  const base = Array.from({ length: 19 }, (_, i) => read(String(i)))
  const x = screen({ state: { results: base, processedResults: base } })
  const out = await x.run([paper('19'), paper('20')], { append: true })
  expect(out.processedResults).toHaveLength(20)
  expect(x.calls.filter((c) => c.startsWith('paper:'))).toEqual(['paper:19'])
  const y = screen({ state: { results: out.results, processedResults: out.processedResults } })
  expect((await y.run([paper('21')], { append: true })).blocked).toBe(true)
  expect(y.calls.filter((c) => /^(paper:|triage:)/.test(c))).toEqual([])
})
