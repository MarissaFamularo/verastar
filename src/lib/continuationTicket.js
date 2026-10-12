// lib/continuationTicket.js — is the run that started still the run that may act?
//
// The continuation gate (lib/digestStore.js, createContinuationGate) answers "is the digest on
// screen held or stopped right now". A run already under way needs a different answer: "has
// anything invalidated ME since I started". The two differ when a hold is followed by a
// deliberately started new scan: the new scan clears the gate, and a check of the gate alone
// would let the old run carry on, send another call, and write its late results over the new
// scan. So each run takes a ticket when it starts and shows it again after every await,
// immediately before it sends anything and before it applies anything that came back.
//
// A ticket goes stale, for good, when after it was taken:
//   - the digest was found held or abandoned (freeze);
//   - the screen was given a different stored digest, or a new scan started (invalidate).
// Clearing the gate never revives a ticket. Work already sent is not recalled: its reply is
// discarded, its cost is not undone.

import { createContinuationGate } from './digestStore.js'

export function createContinuationTickets(gate = createContinuationGate()) {
  let generation = 0
  let issued = 0
  return {
    // The gate's own interface, unchanged for the controls and handlers that read it.
    freeze(state) {
      gate.freeze(state)
      if (gate.blocked()) generation++
    },
    clear: () => gate.clear(),
    state: () => gate.state(),
    blocked: () => gate.blocked(),
    // The screen state was replaced: every run started before this is stale.
    invalidate() { generation++ },
    // Null while the digest is held or stopped: nothing may start.
    begin() { return gate.blocked() ? null : { generation, seq: ++issued } },
    valid: (ticket) => !!ticket && ticket.generation === generation && !gate.blocked(),
    // No run has started since this one. A stale run may still put away its own busy flags,
    // but not once a later run owns them.
    latest: (ticket) => !!ticket && ticket.seq === issued,
  }
}
