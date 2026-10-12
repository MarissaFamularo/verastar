// supabase/functions/_shared/timeouts.js — every wait that bounds a paid attempt, in one place.
//
// Invariants (tested in src/lib/spending.test.js):
//   PROVIDER_TIMEOUT_MS < SERVER_CLIENT_TIMEOUT_MS   the boundary gives up first, so it
//                                                    records the outcome before the SDK aborts
//   SERVER_CLIENT_TIMEOUT_MS < CLAIM_STALE_SECONDS   an admitted scheduler attempt (whose
//                                                    reservation renewed the claim) ends before
//                                                    any successor can take the account over
//   PROVIDER_TIMEOUT_MS < EDGE_IDLE_TIMEOUT_MS       the proxy answers before the platform's
//                                                    150 s request idle timeout
// Every client sets an explicit timeout. That is also what lets @anthropic-ai/sdk 0.110 send
// a large non-streaming request at all: without a client-level timeout it refuses, before
// sending, any max_tokens whose estimated duration exceeds 10 minutes (triage over ~29
// candidates). The explicit value keeps the SDK's own 10-minute ceiling for the browser's
// direct BYOK lane and the edge-bounded ceilings for sponsored lanes.

export const EDGE_IDLE_TIMEOUT_MS = 150_000
export const PROVIDER_TIMEOUT_MS = 140_000
export const SERVER_CLIENT_TIMEOUT_MS = 150_000
export const SPONSORED_CLIENT_TIMEOUT_MS = 150_000
export const BYOK_CLIENT_TIMEOUT_MS = 600_000
export const CLAIM_STALE_SECONDS = 240
