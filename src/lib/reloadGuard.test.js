// reloadGuard.test.js — the refused-save reload must never land on newer screen state.
// Deferred reads make every ordering explicit; nothing here depends on timing.
import { describe, it, expect } from 'vitest'
import { createReloadGuard, reloadIfCurrent } from './reloadGuard.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// A stand-in for the digest screen: what is shown, and the same hooks SpineCheck wires up.
function screen() {
  const guard = createReloadGuard()
  const s = { guard, shown: 'yesterday', ranAt: 'y', busy: false, applied: [] }
  s.show = (digest) => { guard.supersede(); s.shown = digest.name; s.ranAt = digest.ranAt; s.applied.push(digest.name) }
  s.startScan = () => { guard.supersede(); s.busy = true; s.shown = 'scan in progress'; s.ranAt = null }
  s.finishScan = (name) => { s.busy = false; s.shown = name; s.ranAt = 'now' }
  s.reload = (read) => reloadIfCurrent({ guard, load: () => read.promise, apply: s.show, isBusy: () => s.busy })
  return s
}
const stored = { name: 'stored digest', ranAt: 't' }

describe('a reload after a refused save', () => {
  it('shows the stored digest when nothing else happened', async () => {
    const s = screen()
    const read = deferred()
    const done = s.reload(read)
    read.resolve(stored)
    expect(await done).toBe('applied')
    expect([s.shown, s.ranAt]).toEqual(['stored digest', 't'])
  })

  it('does nothing while a run is already in progress, and reads nothing', async () => {
    const s = screen()
    s.busy = true
    let reads = 0
    expect(await reloadIfCurrent({ guard: s.guard, load: async () => { reads++; return stored }, apply: s.show, isBusy: () => s.busy })).toBe('busy')
    expect([reads, s.shown]).toEqual([0, 'yesterday'])
  })

  it('is discarded when a scan started during the read and is STILL RUNNING (the reviewed defect)', async () => {
    const s = screen()
    const read = deferred()
    const done = s.reload(read)
    s.startScan()
    read.resolve(stored)
    expect(await done).not.toBe('applied')
    expect([s.shown, s.ranAt, s.applied]).toEqual(['scan in progress', null, []])
  })

  it('is discarded when a scan started during the read and has ALREADY FINISHED (a late busy check would miss this)', async () => {
    const s = screen()
    const read = deferred()
    const done = s.reload(read)
    s.startScan()
    s.finishScan('new scan result')
    expect(s.busy).toBe(false)
    read.resolve(stored)
    expect(await done).toBe('superseded')
    expect([s.shown, s.ranAt, s.applied]).toEqual(['new scan result', 'now', []])
  })

  it('overlapping reloads: the later one resolves first and wins; the older read is discarded', async () => {
    const s = screen()
    const first = deferred()
    const second = deferred()
    const a = s.reload(first)
    const b = s.reload(second)
    second.resolve({ name: 'newer read', ranAt: 't2' })
    expect(await b).toBe('applied')
    first.resolve({ name: 'older read', ranAt: 't1' })
    expect(await a).toBe('superseded')
    expect([s.shown, s.applied]).toEqual(['newer read', ['newer read']])
  })

  it('overlapping reloads: resolving in order ends on the later read', async () => {
    const s = screen()
    const first = deferred()
    const second = deferred()
    const a = s.reload(first)
    const b = s.reload(second)
    first.resolve({ name: 'older read', ranAt: 't1' })
    await a
    second.resolve({ name: 'newer read', ranAt: 't2' })
    await b
    expect(s.shown).toBe('newer read')
    expect(s.applied.at(-1)).toBe('newer read')
  })

  it('is discarded when another path showed a digest during the read (a server tick, coming back to the app)', async () => {
    const s = screen()
    const read = deferred()
    const done = s.reload(read)
    s.show({ name: 'shown by the visibility handler', ranAt: 't3' })
    read.resolve(stored)
    expect(await done).toBe('superseded')
    expect(s.shown).toBe('shown by the visibility handler')
  })

  it('is discarded after the screen unmounts, and works again after a remount', async () => {
    const s = screen()
    const read = deferred()
    const done = s.reload(read)
    s.guard.dispose()
    read.resolve(stored)
    expect(await done).toBe('superseded')
    expect(s.applied).toEqual([])
    s.guard.mount()
    const again = deferred()
    const next = s.reload(again)
    again.resolve(stored)
    expect(await next).toBe('applied')
  })

  it('an empty slot applies nothing and does not retire other reloads', async () => {
    const s = screen()
    const empty = deferred()
    const real = deferred()
    const a = s.reload(real)
    const b = s.reload(empty)
    empty.resolve(null)
    expect(await b).toBe('empty')
    real.resolve(stored)
    expect(await a).toBe('applied')
  })

  it('a failed read rejects for the caller to log and changes nothing', async () => {
    const s = screen()
    const read = deferred()
    const done = s.reload(read)
    read.reject(new Error('Cloud read failed: network'))
    await expect(done).rejects.toThrow(/network/)
    expect(s.shown).toBe('yesterday')
  })
})
