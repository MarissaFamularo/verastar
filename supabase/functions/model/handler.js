// supabase/functions/model/handler.js — the sponsored model proxy, minus the runtime.
//
// index.ts binds this to Deno.serve, Supabase and Anthropic; vitest binds it to fakes
// (src/lib/modelProxy.test.js). Fronts POST /v1/messages for sponsored accounts: the
// browser's Anthropic SDK uses this function as its baseURL.
//
//   1. Authenticate the Supabase JWT (verified identity is the ONLY account charged).
//   2. Require an active sponsorship (rechecked inside every reservation).
//   3. Read a bounded body; validate it against the paid-request policy.
//   4. Shared-cache READ: an exact cached extraction is returned with no model call.
//   5. Otherwise one guarded provider attempt (_shared/spending.js): reserve, dispatch
//      once, settle/release/mark ambiguous.
//
// The proxy NEVER writes the shared evidence cache: a browser-supplied x-verastar-cache
// header cannot prove which source text, prompt, schema or extraction version produced a
// response. It reads only evidence_cache_trusted, whose rows the scheduled digest wrote
// with server-owned provenance (docs/SPENDING_CONTRACT.md § Cache trust).

import { accountActive, cachedResponse, parseCacheHeader } from './logic.js'
import { checkPaidRequest, readBoundedText } from '../_shared/requestPolicy.js'
import { guardedProviderCall, refusal } from '../_shared/spending.js'

// user-agent: the SDK sets one, and WebKit (every iPhone browser) lists it in the preflight
// where Chromium does not. Without it every sponsored call from an iPhone failed as
// "Connection error." before reaching this function (2026-10-19 beta launch).
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-verastar-cache, x-verastar-purpose, x-verastar-request-id, user-agent',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // The browser SDK must see this header to suppress retries after ambiguous outcomes.
  'Access-Control-Expose-Headers': 'x-verastar-cache, x-verastar-denial, x-verastar-request-id, x-should-retry',
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/

function respond({ status, headers = {}, body }, extra = {}) {
  return new Response(body, { status, headers: { ...CORS, 'content-type': 'application/json', ...headers, ...extra } })
}
const fail = (status, type, message) => respond(refusal(status, type, message))

// deps: { getUser(authHeader) -> user|null, admin (service-role client), ledger, dispatch, randomId? }
export async function handleModelRequest(req, deps) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return fail(405, 'invalid_request_error', 'POST only.')
  if (!new URL(req.url).pathname.endsWith('/v1/messages')) return fail(404, 'not_found_error', 'Only /v1/messages is proxied.')

  let user = null
  try { user = await deps.getUser(req.headers.get('authorization') || '') } catch { user = null }
  if (!user?.id) return fail(401, 'authentication_error', 'Sign in to use sponsored access.')

  const { data: account, error: accountError } = await deps.admin.from('sponsored_accounts').select('user_id, active, ends_at').eq('user_id', user.id).maybeSingle()
  if (accountError) return fail(503, 'api_error', 'Sponsored access is unavailable right now.')
  if (!accountActive(account)) return fail(403, 'permission_error', 'This account is not on sponsored access.')

  if (req.headers.get('anthropic-beta')) return fail(400, 'invalid_request_error', 'Beta features are not available through the sponsored proxy.')
  const requestId = req.headers.get('x-verastar-request-id') || null
  if (requestId && !REQUEST_ID.test(requestId)) return fail(400, 'invalid_request_error', 'x-verastar-request-id is malformed.')

  const read = await readBoundedText(req)
  if (!read.ok) return fail(read.status, read.status === 413 ? 'request_too_large' : 'invalid_request_error', read.error)
  let body
  try { body = JSON.parse(read.text) } catch { return fail(400, 'invalid_request_error', 'Body must be JSON.') }
  const checked = checkPaidRequest(body)
  if (!checked.ok) return fail(400, 'invalid_request_error', checked.error)

  const purpose = (req.headers.get('x-verastar-purpose') || '').slice(0, 40) || null
  const cacheKey = parseCacheHeader(req.headers.get('x-verastar-cache'))

  // Cache READ: no model call, no spend. The reader re-verifies the proposal locally.
  if (cacheKey) {
    try {
      // Trusted rows only (server-owned provenance); legacy evidence_cache rows are a miss.
      const { data: hit, error } = await deps.admin
        .from('evidence_cache_trusted')
        .select('extraction, model, source_hash, provenance')
        .eq('pmid', cacheKey.pmid)
        .eq('extraction_version', cacheKey.extraction_version)
        .eq('source_hash', cacheKey.source_hash)
        .maybeSingle()
      if (!error && hit?.extraction && hit.provenance?.writer === 'digest-run') {
        await deps.admin.from('model_spend').insert({ user_id: user.id, model: hit.model || body.model, purpose, usd: 0, cache_hit: true }).then(() => {}, () => {})
        return respond({ status: 200, body: JSON.stringify(cachedResponse(hit, body.model)) }, { 'x-verastar-cache': 'hit' })
      }
    } catch { /* a cache failure is a cache miss */ }
  }

  const result = await guardedProviderCall({
    ledger: deps.ledger, dispatch: deps.dispatch, userId: user.id, body, requestId, purpose, source: 'proxy',
    countTokens: deps.countTokens, randomId: deps.randomId,
  })
  if (result.outcome === 'denied' && result.reason?.startsWith('cap_')) {
    await deps.admin.from('events').insert({ user_id: user.id, type: 'cap_reached', payload: { scope: result.reason, purpose } }).then(() => {}, () => {})
  }
  return respond(result.response, { 'x-verastar-cache': cacheKey ? 'miss' : 'none' })
}
