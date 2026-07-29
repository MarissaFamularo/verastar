// wakeLock.test.js — the screen wake lock state machine. A digest run is minutes long and
// a phone auto-locks in 1-2 minutes; these lock the guarantees that make holding the
// screen awake safe: it acquires and releases around a run, re-acquires on return to the
// foreground ONLY while a run is in flight, and degrades to a total no-op — never a throw
// — whenever the API is missing or misbehaves.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWakeLock } from './wakeLock.js'

// A fake WakeLockSentinel: records release() calls and lets the test fire the 'release'
// event the real API would fire when the OS or the browser drops the lock on its own.
function makeSentinel() {
  const listeners = {}
  return {
    released: false,
    addEventListener: vi.fn((event, cb) => {
      listeners[event] = cb
    }),
    release: vi.fn(async function () {
      this.released = true
    }),
    __fireRelease() {
      listeners.release?.()
    },
  }
}

// A fake navigator.wakeLock whose request() can be swapped per test (resolve, reject, or
// simply not exist).
function makeNav({ request } = {}) {
  return { wakeLock: request ? { request } : undefined }
}

// A fake document that tracks the single visibilitychange listener and lets tests flip
// visibilityState and fire it, like a real tab hide/show would.
function makeDoc(initialState = 'visible') {
  let handler = null
  return {
    visibilityState: initialState,
    addEventListener: vi.fn((event, cb) => {
      if (event === 'visibilitychange') handler = cb
    }),
    removeEventListener: vi.fn((event, cb) => {
      if (event === 'visibilitychange' && handler === cb) handler = null
    }),
    __setVisible(state) {
      this.visibilityState = state
      handler?.()
    },
    __hasListener: () => handler !== null,
  }
}

describe('acquire / release', () => {
  it('requests a screen lock on start() and holds it', async () => {
    const sentinel = makeSentinel()
    const request = vi.fn(async (type) => {
      expect(type).toBe('screen')
      return sentinel
    })
    const wl = createWakeLock({ nav: makeNav({ request }), doc: makeDoc() })

    await wl.start()

    expect(request).toHaveBeenCalledTimes(1)
    expect(wl._isHeld()).toBe(true)
  })

  it('releases the sentinel on end()', async () => {
    const sentinel = makeSentinel()
    const wl = createWakeLock({
      nav: makeNav({ request: async () => sentinel }),
      doc: makeDoc(),
    })

    await wl.start()
    await wl.end()

    expect(sentinel.release).toHaveBeenCalledTimes(1)
    expect(wl._isHeld()).toBe(false)
    expect(wl._isInFlight()).toBe(false)
  })

  it('double-acquire does not request a second sentinel', async () => {
    const sentinel = makeSentinel()
    const request = vi.fn(async () => sentinel)
    const wl = createWakeLock({ nav: makeNav({ request }), doc: makeDoc() })

    await wl.start()
    await wl.start()

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('double-release does not throw or double-call release()', async () => {
    const sentinel = makeSentinel()
    const wl = createWakeLock({
      nav: makeNav({ request: async () => sentinel }),
      doc: makeDoc(),
    })

    await wl.start()
    await wl.end()
    await expect(wl.end()).resolves.toBeUndefined()
    expect(sentinel.release).toHaveBeenCalledTimes(1)
  })

  it('end() before any start() is a harmless no-op', async () => {
    const wl = createWakeLock({ nav: makeNav({ request: vi.fn() }), doc: makeDoc() })
    await expect(wl.end()).resolves.toBeUndefined()
    expect(wl._isHeld()).toBe(false)
  })
})

describe('re-acquire on visibilitychange', () => {
  it('re-acquires when the tab returns to visible WHILE a run is in flight', async () => {
    const first = makeSentinel()
    const second = makeSentinel()
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const doc = makeDoc('visible')
    const wl = createWakeLock({ nav: makeNav({ request }), doc })

    await wl.start()
    expect(wl._isHeld()).toBe(true)

    // iOS drops the lock the instant the tab hides, and fires 'release' on the sentinel.
    doc.__setVisible('hidden')
    first.__fireRelease()
    expect(wl._isHeld()).toBe(false)

    doc.__setVisible('visible')
    // acquire() is async — flush microtasks.
    await Promise.resolve()
    await Promise.resolve()

    expect(request).toHaveBeenCalledTimes(2)
    expect(wl._isHeld()).toBe(true)
  })

  it('does NOT re-acquire on visibilitychange once the run has ended', async () => {
    const sentinel = makeSentinel()
    const request = vi.fn(async () => sentinel)
    const doc = makeDoc('visible')
    const wl = createWakeLock({ nav: makeNav({ request }), doc })

    await wl.start()
    await wl.end()
    request.mockClear()

    doc.__setVisible('hidden')
    doc.__setVisible('visible')
    await Promise.resolve()

    expect(request).not.toHaveBeenCalled()
  })

  it('attaches the visibilitychange listener once even across repeated starts', async () => {
    const doc = makeDoc()
    const wl = createWakeLock({ nav: makeNav({ request: async () => makeSentinel() }), doc })

    await wl.start()
    await wl.start()

    expect(doc.addEventListener).toHaveBeenCalledTimes(1)
  })
})

describe('destroy() — component unmount', () => {
  it('releases the lock, detaches the listener, and stops future re-acquires', async () => {
    const sentinel = makeSentinel()
    const request = vi.fn(async () => sentinel)
    const doc = makeDoc('visible')
    const wl = createWakeLock({ nav: makeNav({ request }), doc })

    await wl.start()
    await wl.destroy()

    expect(sentinel.release).toHaveBeenCalledTimes(1)
    expect(doc.__hasListener()).toBe(false)

    doc.__setVisible('hidden')
    doc.__setVisible('visible')
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1) // no second acquire after destroy
  })
})

describe('degrades to a silent no-op — never throws into the caller', () => {
  it('when navigator.wakeLock is entirely absent', async () => {
    const wl = createWakeLock({ nav: {}, doc: makeDoc() })
    await expect(wl.start()).resolves.toBeUndefined()
    expect(wl._isHeld()).toBe(false)
    await expect(wl.end()).resolves.toBeUndefined()
  })

  it('when navigator itself is absent (old browser / non-DOM environment)', async () => {
    const wl = createWakeLock({ nav: undefined, doc: undefined })
    await expect(wl.start()).resolves.toBeUndefined()
    await expect(wl.end()).resolves.toBeUndefined()
    await expect(wl.destroy()).resolves.toBeUndefined()
  })

  it('when request() rejects', async () => {
    const request = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    const wl = createWakeLock({ nav: makeNav({ request }), doc: makeDoc() })
    await expect(wl.start()).resolves.toBeUndefined()
    expect(wl._isHeld()).toBe(false)
  })

  it('when sentinel.release() itself throws', async () => {
    const sentinel = makeSentinel()
    sentinel.release.mockRejectedValue(new Error('already released'))
    const wl = createWakeLock({ nav: makeNav({ request: async () => sentinel }), doc: makeDoc() })

    await wl.start()
    await expect(wl.end()).resolves.toBeUndefined()
  })

  it('when document is unavailable, start() and end() still resolve', async () => {
    const wl = createWakeLock({ nav: makeNav({ request: async () => makeSentinel() }), doc: undefined })
    await expect(wl.start()).resolves.toBeUndefined()
    await expect(wl.end()).resolves.toBeUndefined()
  })
})
