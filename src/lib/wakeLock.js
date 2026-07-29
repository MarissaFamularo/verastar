// lib/wakeLock.js — keep the screen awake for the length of a digest run.
//
// A run is minutes long: the search, the scoring call, the paper loop (each paper is a
// real extraction call), and the ranking/prose-check pass after it. A phone auto-locks in
// 1-2 minutes; once the screen sleeps the browser backgrounds or discards the page and the
// run dies mid-flight. This is the mitigation, via the Screen Wake Lock API (Safari 16.4+).
//
// Advisory only, exactly like the prose gate in pipeline/check.js: the API may not exist,
// the request may be rejected, or a browser may throw in a way the spec doesn't predict.
// None of that may ever surface as a digest failure, so every path here is self-catching
// and every public method resolves — never rejects, never throws into the caller.
//
// iOS releases the lock the instant the tab is hidden — glancing at another app, locking
// the screen by hand, switching apps — and that is NOT the same as the run ending. So
// `start()` also arms a `visibilitychange` listener that re-acquires on return to the
// foreground, but ONLY while a run is actually in flight; otherwise an unrelated tab
// switch minutes after a run finished would silently re-arm the lock.

// A factory rather than a bare module singleton so the state machine is exercisable in
// isolation with a mocked `navigator`/`document` — real usage wants the shared instance
// below.
export function createWakeLock({ nav, doc } = {}) {
  const navigatorRef = nav ?? (typeof navigator !== 'undefined' ? navigator : undefined)
  const docRef = doc ?? (typeof document !== 'undefined' ? document : undefined)

  let sentinel = null // the held WakeLockSentinel, or null
  let inFlight = false // a run is in progress — gates the visibilitychange re-acquire
  let listening = false // whether the visibilitychange handler is currently attached

  async function acquire() {
    if (sentinel) return // idempotent — already held
    const request = navigatorRef?.wakeLock?.request
    if (typeof request !== 'function') return // API absent (older browser) — silent no-op
    try {
      const s = await request.call(navigatorRef.wakeLock, 'screen')
      // A release can arrive from any source — the OS, another caller, iOS backgrounding
      // the tab — not just our own release(). Clear the reference so a later
      // visibilitychange finds `sentinel` empty and re-acquires instead of trusting a
      // sentinel that's already dead.
      s.addEventListener?.('release', () => {
        if (sentinel === s) sentinel = null
      })
      sentinel = s
    } catch {
      // Rejected — e.g. requested while already hidden, or low battery. Degrade silently.
      sentinel = null
    }
  }

  async function release() {
    const s = sentinel
    sentinel = null
    if (!s) return
    try {
      await s.release()
    } catch {
      // Already released, or unreleasable — nothing left to do.
    }
  }

  function onVisibilityChange() {
    if (inFlight && docRef?.visibilityState === 'visible') acquire()
  }

  function listen() {
    if (listening || !docRef?.addEventListener) return
    docRef.addEventListener('visibilitychange', onVisibilityChange)
    listening = true
  }

  function unlisten() {
    if (!listening) return
    docRef.removeEventListener('visibilitychange', onVisibilityChange)
    listening = false
  }

  return {
    // Call at the start of a run — ideally as close to the triggering click as possible,
    // since Safari only grants the lock inside a user-gesture call stack. Idempotent.
    async start() {
      inFlight = true
      listen()
      await acquire()
    },
    // Call in a `finally` around the run — success, failure, or abort must all release.
    // Idempotent.
    async end() {
      inFlight = false
      await release()
    },
    // Component unmount: stop listening and drop the lock outright, regardless of whether
    // a run is (conceptually) still in flight — there is no screen left here to protect.
    async destroy() {
      inFlight = false
      unlisten()
      await release()
    },
    // Inspection only, for tests — not used by application code.
    _isHeld: () => sentinel !== null,
    _isInFlight: () => inFlight,
  }
}

// One shared instance. SpineCheck is the only caller today, and only one run can ever be
// in flight at a time (the UI disables every run trigger while busy), so a singleton is
// simpler to wire than threading an instance through props/context.
export const wakeLock = createWakeLock()
