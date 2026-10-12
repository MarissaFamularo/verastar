// Test doubles for the paid-call boundary: an in-memory ledger with the same state rules as
// the spend_* database functions, and a scripted provider that records every dispatch.
// Test-only; never imported by app code.

// ownsClaim(userId, token) models the claim check spend_reserve performs for scheduler
// attempts; omit it to treat every scheduler token as current.
export function fakeLedger({ deny = null, denyAfter = Infinity, reserveThrows = false, settleFails = 0, ambiguousFails = 0, settleStatus = null, ownsClaim = null } = {}) {
  const rows = new Map()
  const calls = []
  let n = 0
  return {
    rows,
    calls,
    outstanding: () => [...rows.values()].filter((r) => r.state === 'reserved' || r.state === 'ambiguous').reduce((a, r) => a + r.micro, 0),
    async reserve(r) {
      calls.push('reserve')
      if (reserveThrows) throw new Error('db down')
      if (r.source === 'scheduler' && ownsClaim && !ownsClaim(r.userId, r.claimToken)) return { status: 'denied', reason: 'claim_lost' }
      if (deny) return { status: 'denied', reason: deny }
      if (rows.size >= denyAfter) return { status: 'denied', reason: 'cap_day' }
      for (const row of rows.values()) {
        if (row.userId === r.userId && row.requestId === r.requestId) return { status: row.fingerprint === r.fingerprint ? 'duplicate' : 'mismatch', state: row.state }
      }
      const id = `res-${++n}`
      rows.set(id, { ...r, state: 'reserved' })
      return { status: 'reserved', reservation_id: id, reserved_micro: r.micro }
    },
    async settle(s) {
      calls.push('settle')
      if (settleFails-- > 0) throw new Error('settle failed')
      const row = rows.get(s.reservationId)
      if (settleStatus) return { status: settleStatus }
      if (row.state === 'settled') return { status: row.actual === s.micro ? 'already_settled' : 'conflict' }
      row.state = 'settled'
      row.actual = s.micro
      return { status: s.micro > row.micro ? 'overrun' : 'settled' }
    },
    async markAmbiguous(id, reason) {
      calls.push('ambiguous')
      if (ambiguousFails-- > 0) throw new Error('mark failed')
      const row = rows.get(id)
      if (row.state !== 'reserved') return { status: 'unchanged' }
      row.state = 'ambiguous'
      row.reason = reason
      return { status: 'ambiguous' }
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
    if (step instanceof Response) return step
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } })
  }
  return { dispatch, sent }
}
