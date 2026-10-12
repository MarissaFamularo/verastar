// supabase/functions/_shared/spending.js — the ONE boundary every sponsor-paid provider
// attempt crosses, from the browser proxy (functions/model) and the scheduled digest
// (functions/digest-run) alike.
//
//   check  -> reserve -> dispatch exactly once -> settle | mark ambiguous
//
// - check:    requestPolicy.checkPaidRequest; nothing unchecked is forwarded.
// - reserve:  spend_reserve RPC, one transaction under a global lock: account, config,
//             pause, overrun review, per-person day/month caps, global ceiling, total
//             budget, and request-id binding. Any RPC error means NO dispatch.
// - dispatch: one HTTP attempt to Anthropic. This module never retries; a caller's retry
//             is a new attempt with a new request id and a new reservation.
// - outcome:  2xx with priceable usage for the requested model -> settle (actual cost,
//             unused balance released; above-bound actual recorded in full as an overrun).
//             Anything else after dispatch -> ambiguous: ANY non-2xx status (4xx included:
//             no provider status is documented as proof of zero charge), timeout, network
//             loss, unparseable body, missing or unpriceable usage, unexpected model. The
//             FULL reservation stays counted until an operator reconciles it
//             (docs/SPENDING_CONTRACT.md). Ambiguous responses carry x-should-retry: false
//             so no SDK stacks automatic retries on top of an unresolved liability.
// Scheduler attempts carry the run's claim token; the reservation is refused unless the
// run still owns the account (spend_reserve checks and renews the claim atomically).
// If recording the outcome itself fails, the reservation stays 'reserved' (counted in
// full) and the result says so, so a scheduler run stops making further calls.

import { checkPaidRequest, requestFingerprint } from './requestPolicy.js'
import { priceUsage, responseModelMatches } from './pricing.js'
import { PROVIDER_TIMEOUT_MS } from './timeouts.js'

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_VERSION = '2023-06-01'
export { PROVIDER_TIMEOUT_MS }

export const CAP_MESSAGE = 'You have read a lot today. New papers pick up tomorrow morning. Everything already in your library still works.'
export const PAUSE_MESSAGE = 'Sponsored reading is paused right now. Everything already in your library still works.'

const SPEND_STOPS = new Set(['cap_day', 'cap_month', 'cap_global', 'budget_total'])

// An Anthropic-shaped error so the SDK surfaces a typed APIError. x-should-retry: false
// stops the SDK from retrying a refusal (it would only be refused again).
export function refusal(status, type, message, extra = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'x-should-retry': 'false', ...extra },
    body: JSON.stringify({ type: 'error', error: { type, message } }),
  }
}

// Map a reservation denial to the caller-facing refusal. Spending stops are 402 (the app
// treats 402 as "cap reached": the digest stops and keeps its progress; the SDK never
// retries it). An inactive account is 403.
export function denialResponse(reason) {
  if (reason === 'claim_lost') return refusal(402, 'spending_paused', 'This scheduled run no longer owns the account; nothing was sent.', { 'x-verastar-denial': 'claim_lost' })
  if (reason === 'account_inactive') return refusal(403, 'permission_error', 'This account is not on sponsored access.')
  if (SPEND_STOPS.has(reason)) return refusal(402, 'cap_reached', CAP_MESSAGE, { 'x-verastar-denial': reason })
  return refusal(402, 'spending_paused', PAUSE_MESSAGE, { 'x-verastar-denial': reason || 'unknown' })
}

// The RPC-backed ledger. Every method throws on a transport/database error; callers treat
// a throw as "accounting unavailable".
export function makeRpcLedger(admin) {
  const call = async (fn, args) => {
    const { data, error } = await admin.rpc(fn, args)
    if (error) throw new Error(`${fn} failed: ${error.message || error}`)
    if (!data || typeof data !== 'object') throw new Error(`${fn} returned no result`)
    return data
  }
  return {
    reserve: (r) => call('spend_reserve', {
      p_user_id: r.userId, p_request_id: r.requestId, p_fingerprint: r.fingerprint, p_model: r.model,
      p_purpose: r.purpose, p_source: r.source, p_reserve_micro: r.micro,
      p_max_input_tokens: r.maxInputTokens, p_max_output_tokens: r.maxOutputTokens,
      p_claim_token: r.claimToken ?? null,
    }),
    settle: (s) => call('spend_settle', {
      p_reservation_id: s.reservationId, p_actual_micro: s.micro, p_model: s.model,
      p_input_tokens: s.tokens.input, p_output_tokens: s.tokens.output,
      p_cache_read_tokens: s.tokens.cacheRead, p_cache_write_tokens: s.tokens.cacheWrite,
      p_provider_request_id: s.providerRequestId, p_provider_message_id: s.providerMessageId,
    }),
    markAmbiguous: (id, reason, providerRequestId) => call('spend_mark_ambiguous', { p_reservation_id: id, p_reason: reason, p_provider_request_id: providerRequestId }),
  }
}

async function tryTwice(fn) {
  try {
    return await fn()
  } catch {
    return await fn()
  }
}

// One sponsor-paid attempt. Resolves { response: { status, headers, body }, outcome, ... }.
// Never throws for provider or accounting failures; programming errors still throw.
//   ledger     makeRpcLedger(admin) or a test fake
//   dispatch   (text, { signal }) => Promise<Response>  — the only network call
//   body       the parsed request the caller sent
//   requestId  caller-supplied id (bound to account + fingerprint), or one is generated
export async function guardedProviderCall({ ledger, dispatch, userId, body, requestId, purpose = null, source, claimToken = null, timeoutMs = PROVIDER_TIMEOUT_MS, randomId = () => globalThis.crypto.randomUUID() }) {
  const checked = checkPaidRequest(body)
  if (!checked.ok) return { outcome: 'invalid', dispatched: false, response: refusal(400, 'invalid_request_error', checked.error) }

  const rid = requestId || `srv-${randomId()}`
  const fingerprint = await requestFingerprint(checked.forwardText, purpose)

  let reservation
  try {
    reservation = await ledger.reserve({
      userId, requestId: rid, fingerprint, model: checked.forward.model, purpose, source,
      micro: checked.bound.micro, maxInputTokens: checked.bound.maxInputTokens, maxOutputTokens: checked.bound.maxOutputTokens,
      claimToken,
    })
  } catch {
    return { outcome: 'accounting_unavailable', dispatched: false, accountingFailed: true, response: refusal(503, 'api_error', 'Sponsored accounting is unavailable; nothing was sent.') }
  }
  if (reservation.status === 'denied') return { outcome: 'denied', reason: reservation.reason, dispatched: false, response: denialResponse(reservation.reason) }
  if (reservation.status === 'duplicate' || reservation.status === 'mismatch') {
    return { outcome: reservation.status, dispatched: false, response: refusal(409, 'invalid_request_error', reservation.status === 'duplicate' ? 'This request id was already used; nothing was sent again.' : 'This request id was used for a different request.') }
  }
  if (reservation.status !== 'reserved' || !reservation.reservation_id) {
    return { outcome: 'accounting_unavailable', dispatched: false, accountingFailed: true, response: refusal(503, 'api_error', 'Sponsored accounting is unavailable; nothing was sent.') }
  }
  const reservationId = reservation.reservation_id

  // From here on the attempt may be billed.
  const ambiguous = async (reason, providerRequestId, response) => {
    let recorded = true
    try { await tryTwice(() => ledger.markAmbiguous(reservationId, reason, providerRequestId)) } catch { recorded = false }
    // Unrecorded is still counted: the row stays 'reserved', which is outstanding.
    return { outcome: 'ambiguous', reason, dispatched: true, reservationId, accountingFailed: !recorded, response }
  }

  let upstream
  let text
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    upstream = await dispatch(checked.forwardText, { signal: controller.signal })
    text = await upstream.text()
  } catch {
    clearTimeout(timer)
    const reason = controller.signal.aborted ? 'timeout' : 'network_error'
    return ambiguous(reason, null, refusal(504, 'api_error', `The model call did not complete (${reason}).`))
  }
  clearTimeout(timer)
  const providerRequestId = upstream.headers?.get?.('request-id') || null
  const passthrough = { status: upstream.status, headers: { 'content-type': 'application/json' }, body: text }

  if (upstream.status < 200 || upstream.status >= 300) {
    // Passed through so the SDK keeps its typed error, but never auto-retried.
    return ambiguous(`provider_status_${upstream.status}`, providerRequestId, { ...passthrough, headers: { ...passthrough.headers, 'x-should-retry': 'false' } })
  }

  let res
  try { res = JSON.parse(text) } catch { return ambiguous('unparseable_response', providerRequestId, refusal(502, 'api_error', 'Upstream returned a non-JSON response.')) }
  // A 2xx we cannot price is still returned to the caller (it was paid for), with its
  // liability retained as ambiguous.
  if (!responseModelMatches(checked.forward.model, res?.model)) return ambiguous('unexpected_model', providerRequestId, passthrough)
  const priced = priceUsage(checked.forward.model, res?.usage)
  if (!priced.ok) return ambiguous(priced.reason, providerRequestId, passthrough)

  try {
    const settled = await tryTwice(() => ledger.settle({
      reservationId, micro: priced.micro, model: checked.forward.model, tokens: priced.tokens,
      providerRequestId, providerMessageId: typeof res.id === 'string' ? res.id : null,
    }))
    if (settled.status === 'settled' || settled.status === 'already_settled') {
      return { outcome: 'settled', dispatched: true, reservationId, micro: priced.micro, response: passthrough }
    }
    // overrun: the bill is recorded in full and new reservations are already stopped.
    // conflict/not_found: the ledger disagrees with what just happened; stop this run.
    return { outcome: settled.status, dispatched: true, reservationId, micro: priced.micro, accountingFailed: settled.status !== 'overrun', overrun: settled.status === 'overrun', response: passthrough }
  } catch {
    return { outcome: 'settlement_failed', dispatched: true, reservationId, micro: priced.micro, accountingFailed: true, response: passthrough }
  }
}

// Where paid attempts go. Production: always ANTHROPIC_URL. A local-stack test
// (scripts/local-stack-spending-test.mjs) may point the functions at a FAKE provider, but
// only when every guard holds; otherwise an override that is set at all is refused, so a
// misconfigured deployment fails closed instead of sending the sponsor key elsewhere:
//   - VERASTAR_TEST_PROVIDER_URL is http on a loopback/docker-host name,
//   - SUPABASE_URL is a local stack (kong, localhost, 127.0.0.1),
//   - ANTHROPIC_API_KEY is a fake key (sk-fake-...).
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', 'host.docker.internal', 'kong'])
export function resolveProviderUrl(env) {
  const override = env.VERASTAR_TEST_PROVIDER_URL
  if (!override) return { ok: true, url: ANTHROPIC_URL }
  let target, supa
  try { target = new URL(override); supa = new URL(env.SUPABASE_URL || '') } catch { return { ok: false, error: 'invalid test provider override' } }
  const ok = target.protocol === 'http:' && LOCAL_HOSTS.has(target.hostname) && target.pathname.endsWith('/v1/messages')
    && LOCAL_HOSTS.has(supa.hostname) && /^sk-fake-/.test(env.ANTHROPIC_API_KEY || '')
  return ok ? { ok: true, url: target.href, test: true } : { ok: false, error: 'test provider override refused outside a local stack' }
}

// Real dispatch to Anthropic with only the headers the API needs. The caller's headers,
// beta flags and version are never forwarded.
export function anthropicDispatch(apiKey, fetchImpl = globalThis.fetch, url = ANTHROPIC_URL) {
  return (text, { signal } = {}) => fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: text,
    signal,
  })
}

// A fetch for the Anthropic SDK on the server: every request the SDK makes becomes one
// guarded attempt for `userId`, bound to the run's `claimToken`. The run is halted — every
// later attempt refused WITHOUT reserving or dispatching — once any accounting step fails,
// an overrun is recorded, an outcome is ambiguous, or the claim is lost. All refusals are
// 402 so the digest runner stops and keeps its progress.
export function makeGuardedFetch({ ledger, dispatch, userId, claimToken = null, purpose = 'scheduled-digest', source = 'scheduler', onOutcome = () => {}, randomId }) {
  const state = { halted: null, attempts: 0, dispatched: 0 }
  const toResponse = (r) => new Response(r.body, { status: r.status, headers: r.headers })
  const guardedFetch = async (url, init = {}) => {
    if (!String(url).endsWith('/v1/messages') || String(init.method || 'GET').toUpperCase() !== 'POST') {
      return toResponse(refusal(404, 'not_found_error', 'Only POST /v1/messages is available to the scheduler.'))
    }
    if (state.halted) return toResponse(refusal(402, 'spending_paused', PAUSE_MESSAGE, { 'x-verastar-denial': `halted:${state.halted}` }))
    let body
    try { body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) } catch { return toResponse(refusal(400, 'invalid_request_error', 'Body must be JSON.')) }
    state.attempts++
    const result = await guardedProviderCall({ ledger, dispatch, userId, body, purpose, source, claimToken, randomId })
    if (result.dispatched) state.dispatched++
    if (result.accountingFailed || result.overrun || result.outcome === 'ambiguous') state.halted = result.outcome
    if (result.outcome === 'denied' && result.reason === 'claim_lost') state.halted = 'claim_lost'
    onOutcome(result)
    // Refusals that are not spending stops still end the run as a stop, not a retry.
    if (!result.dispatched && result.response.status !== 402 && result.response.status !== 400) {
      return toResponse(refusal(402, 'spending_paused', PAUSE_MESSAGE, { 'x-verastar-denial': result.outcome }))
    }
    return toResponse(result.response)
  }
  return { fetch: guardedFetch, state }
}
