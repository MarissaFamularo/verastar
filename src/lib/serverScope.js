// lib/serverScope.js — per-request context for app code that also runs on the server.
//
// The scheduled digest (supabase/functions/digest-run) runs the app's own pipeline for one
// account at a time, but an edge isolate can serve overlapping requests. Module-level
// "current account" variables would let one request's awaits observe another request's
// storage, model client or cache writer. Instead, the server installs a getter backed by
// AsyncLocalStorage and runs each account's work inside its own scope; store.js,
// anthropic.js and evidenceCache.js read the scope at call time.
//
// In the browser nothing is installed and every function here is inert. On the server,
// once a getter is installed, code that runs OUTSIDE a scope throws instead of falling
// back to a global: no storage, model or cache access without an account bound.

let _getter = null

export function installServerScope(getter) {
  _getter = typeof getter === 'function' ? getter : null
}

export function serverScopeInstalled() {
  return _getter !== null
}

// The active scope ({ userId, store, client, cache }), null in the browser, or a throw on
// the server outside a scope.
export function currentServerScope() {
  if (!_getter) return null
  const scope = _getter()
  if (!scope) throw new Error('Server code ran outside an account scope.')
  return scope
}

// Has this scheduled run left a paid attempt unresolved (dispatched, with no confirmed cost)?
// The scheduler's handler records that on the run's scope as it happens (scope.run.unresolved);
// the digest runner reads it here so it stops instead of treating the failed step as a finished
// one. Null in the browser, outside a scope, and for a run with nothing unresolved.
export function serverRunUnresolved() {
  if (!_getter) return null
  return _getter()?.run?.unresolved ?? null
}
