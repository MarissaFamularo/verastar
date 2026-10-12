// Test doubles for the paid-call boundary: an in-memory ledger with the same state rules as
// the spend_* database functions, and a scripted provider that records every dispatch.
// Test-only; never imported by app code.

// ownsClaim(userId, token) models the claim check spend_reserve performs for scheduler
// attempts; omit it to treat every scheduler token as current.
// capMicro, when finite, is the account's remaining cap. Reserve, settle and release share
// one lock, the way spend_lock serializes them, so parallel reserves cannot jointly pass it.
export function fakeLedger({ deny = null, denyAfter = Infinity, capMicro = Infinity, reserveThrows = false, settleFails = 0, ambiguousFails = 0, releaseFails = 0, releaseStatus = null, settleStatus = null, ownsClaim = null } = {}) {
  const rows = new Map()
  const calls = []
  let n = 0
  let tail = Promise.resolve()
  const locked = (fn) => {
    const run = tail.then(fn, fn)
    tail = run.then(() => {}, () => {})
    return run
  }
  const outstandingOf = () => [...rows.values()].filter((r) => r.state === 'reserved' || r.state === 'ambiguous').reduce((a, r) => a + r.micro, 0)
  const chargedOf = () => [...rows.values()].filter((r) => r.state === 'settled' || r.state === 'reconciled').reduce((a, r) => a + (r.actual ?? 0), 0)
  return {
    rows,
    calls,
    outstanding: outstandingOf,
    charged: chargedOf,
    async reserve(r) {
      return locked(async () => {
        calls.push('reserve')
        if (reserveThrows) throw new Error('db down')
        if (r.source === 'scheduler' && ownsClaim && !ownsClaim(r.userId, r.claimToken)) return { status: 'denied', reason: 'claim_lost' }
        if (deny) return { status: 'denied', reason: deny }
        if (rows.size >= denyAfter) return { status: 'denied', reason: 'cap_day' }
        for (const row of rows.values()) {
          if (row.userId === r.userId && row.requestId === r.requestId) return { status: row.fingerprint === r.fingerprint ? 'duplicate' : 'mismatch', state: row.state }
        }
        if (Number.isFinite(capMicro) && outstandingOf() + chargedOf() + r.micro > capMicro) return { status: 'denied', reason: 'cap_day' }
        const id = `res-${++n}`
        rows.set(id, { ...r, state: 'reserved' })
        return { status: 'reserved', reservation_id: id, reserved_micro: r.micro }
      })
    },
    async settle(s) {
      return locked(async () => {
        calls.push('settle')
        if (settleFails-- > 0) throw new Error('settle failed')
        const row = rows.get(s.reservationId)
        if (settleStatus) return { status: settleStatus }
        if (!row) return { status: 'not_found' }
        // reserved, ambiguous, and released can all record a confirmed charge.
        if (row.state === 'settled' || row.state === 'reconciled') return { status: row.actual === s.micro ? 'already_settled' : 'conflict' }
        row.state = 'settled'
        row.actual = s.micro
        return { status: s.micro > row.micro ? 'overrun' : 'settled' }
      })
    },
    async markAmbiguous(id, reason) {
      return locked(async () => {
        calls.push('ambiguous')
        if (ambiguousFails-- > 0) throw new Error('mark failed')
        const row = rows.get(id)
        if (row.state !== 'reserved') return { status: 'unchanged' }
        row.state = 'ambiguous'
        row.reason = reason
        return { status: 'ambiguous' }
      })
    },
    async release(id, reason) {
      return locked(async () => {
        calls.push('release')
        if (releaseFails-- > 0) throw new Error('release failed')
        if (releaseStatus) return { status: releaseStatus }
        const row = rows.get(id)
        if (!row) return { status: 'not_found' }
        if (row.state === 'released') return { status: 'already_released' }
        if (row.state !== 'reserved') return { status: 'unchanged', state: row.state }
        row.state = 'released'
        row.actual = 0
        row.reason = reason
        return { status: 'released' }
      })
    },
  }
}

export function fakeProvider(script) {
  const sent = []
  const dispatch = async (text, { signal } = {}) => {
    sent.push(JSON.parse(text))
    const step = typeof script === 'function' ? script(sent.length) : script
    if (step === 'hang') {
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }
    if (step === 'network') throw new TypeError('fetch failed')
    if (step === 'refused') {
      const err = new TypeError('fetch failed')
      err.cause = { code: 'ECONNREFUSED' }
      throw err
    }
    if (step === 'interrupt') {
      return {
        status: 200,
        headers: { get: (name) => (name === 'request-id' ? 'req_cut' : null) },
        text: async () => { throw new TypeError('terminated') },
      }
    }
    if (step instanceof Response) return step
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } })
  }
  return { dispatch, sent }
}
