// lib/reloadGuard.js — which background reload of the digest screen is still wanted.
//
// When a save is refused (lib/digestStore.js) the digest screen reads the stored digest and
// shows it. That read takes time. If the reader starts a scan meanwhile, or the screen has
// already shown something newer, or the screen is gone, applying the read would put an old
// digest (and its scan date and origin) over newer screen state. A flag checked before the
// read cannot see any of that, and a "busy" check after it misses a scan that has already
// finished. So each reload takes a ticket when it starts and is applied only if the ticket
// is still good when the read resolves.
//
// A ticket goes stale when, after it was taken:
//   - the screen state was replaced: a scan started, or any digest was shown (supersede);
//   - a reload that STARTED LATER was already applied (an older read never follows a newer one);
//   - the screen unmounted (dispose).

export function createReloadGuard() {
  let epoch = 0
  let issued = 0
  let applied = 0
  let mounted = true
  let applying = false
  return {
    mount() { mounted = true },
    dispose() { mounted = false; epoch++ },
    // Showing a reload's own digest is not a new event: older tickets are already retired by
    // accept(), and a reload that started later must still be allowed to follow it.
    supersede() { if (!applying) epoch++ },
    begin() { return { epoch, seq: ++issued } },
    // True once, for a ticket that is still good; taking it retires every older ticket.
    // The caller applies the read synchronously and then calls applied().
    accept(ticket) {
      if (!mounted || !ticket || ticket.epoch !== epoch || ticket.seq <= applied) return false
      applied = ticket.seq
      applying = true
      return true
    },
    applied() { applying = false },
  }
}

// Read the stored digest and apply it only if nothing has superseded this reload by the time
// the read resolves. Resolves to what happened: 'applied', 'busy', 'empty' or 'superseded'.
// `apply` may itself call guard.supersede() (showing a digest replaces the screen state).
export async function reloadIfCurrent({ guard, load, apply, isBusy = () => false }) {
  if (isBusy()) return 'busy'
  const ticket = guard.begin()
  const saved = await load()
  if (!saved) return 'empty'
  if (isBusy()) return 'busy'
  if (!guard.accept(ticket)) return 'superseded'
  try {
    apply(saved)
  } finally {
    guard.applied()
  }
  return 'applied'
}
