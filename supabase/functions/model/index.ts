// supabase/functions/model/index.ts — the sponsored model proxy.
//
// Fronts POST /v1/messages for accounts the sponsor pays for. The Anthropic SDK in the
// browser is pointed at this function as its baseURL, so call sites are unchanged; the
// function swaps the caller's Supabase JWT for the sponsor key held in secrets.
//
//   1. Authenticate the Supabase JWT.
//   2. Require an active sponsored_accounts row.
//   3. Serve an extraction from evidence_cache when the client names the exact source.
//   4. Check per-day, per-month, and global caps from model_spend + sponsor_config.
//   5. Forward to Anthropic; record spend; write the extraction to the cache.
//
// Cap values live in the database, never here. Secrets: ANTHROPIC_API_KEY,
// SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (the last three are
// injected by the platform).

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  accountActive,
  capReached,
  cachedResponse,
  costUsd,
  effectiveCaps,
  extractionFromResponse,
  parseCacheHeader,
  validateRequest,
  windows,
  CAP_MESSAGE,
} from './logic.js'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-verastar-cache, x-verastar-purpose',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
  })
}

// Errors take Anthropic's own envelope so the SDK surfaces them as typed APIErrors.
function apiError(status: number, type: string, message: string) {
  return json(status, { type: 'error', error: { type, message } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return apiError(405, 'invalid_request_error', 'POST only.')
  if (!new URL(req.url).pathname.endsWith('/v1/messages')) {
    return apiError(404, 'not_found_error', 'Only /v1/messages is proxied.')
  }

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!anthropicKey || !supabaseUrl || !anonKey || !serviceKey) {
    return apiError(500, 'api_error', 'Proxy is not configured.')
  }

  // 1. Who is calling. The SDK sends the JWT on Authorization; the platform gateway
  //    already required a valid apikey/JWT to reach us, but we verify the user ourselves.
  const authHeader = req.headers.get('authorization') || ''
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
  const { data: userData, error: userErr } = await userClient.auth.getUser()
  const user = userData?.user
  if (userErr || !user) return apiError(401, 'authentication_error', 'Sign in to use sponsored access.')

  // 2. Is this account sponsored right now.
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const { data: account } = await admin.from('sponsored_accounts').select('*').eq('user_id', user.id).maybeSingle()
  if (!accountActive(account)) return apiError(403, 'permission_error', 'This account is not on sponsored access.')

  let body: any
  try {
    body = await req.json()
  } catch {
    return apiError(400, 'invalid_request_error', 'Body must be JSON.')
  }
  const invalid = validateRequest(body)
  if (invalid) return apiError(400, 'invalid_request_error', invalid)

  const purpose = (req.headers.get('x-verastar-purpose') || '').slice(0, 40) || null
  const cacheKey = parseCacheHeader(req.headers.get('x-verastar-cache'))

  // 3. Cache hit: no model call, no spend, no cap check. The client re-verifies locally.
  if (cacheKey) {
    const { data: hit } = await admin
      .from('evidence_cache')
      .select('extraction, model, source_hash')
      .eq('pmid', cacheKey.pmid)
      .eq('extraction_version', cacheKey.extraction_version)
      .eq('source_hash', cacheKey.source_hash)
      .maybeSingle()
    if (hit?.extraction) {
      await admin.from('model_spend').insert({
        user_id: user.id, model: hit.model || body.model, purpose, usd: 0, cache_hit: true,
      })
      return json(200, cachedResponse(hit, body.model), { 'x-verastar-cache': 'hit' })
    }
  }

  // 4. Caps. Three sums from the ledger, one config row.
  const { data: config } = await admin.from('sponsor_config').select('*').eq('id', true).maybeSingle()
  if (!config) return apiError(500, 'api_error', 'Sponsor configuration is missing.')
  const { dayStart, monthStart } = windows()
  const sum = async (sinceIso: string, userId: string | null) => {
    let q = admin.from('model_spend').select('usd').gte('ts', sinceIso)
    if (userId) q = q.eq('user_id', userId)
    const { data } = await q
    return (data || []).reduce((acc: number, r: any) => acc + Number(r.usd || 0), 0)
  }
  const [spentToday, spentMonth, spentGlobalMonth] = await Promise.all([
    sum(dayStart, user.id), sum(monthStart, user.id), sum(monthStart, null),
  ])
  const which = capReached({ spentToday, spentMonth, spentGlobalMonth }, effectiveCaps(account, config))
  if (which) {
    await admin.from('events').insert({ user_id: user.id, type: 'cap_reached', payload: { scope: which, purpose } })
    // 402 is deliberate: the SDK does not retry it, and nothing else returns it.
    return apiError(402, 'cap_reached', CAP_MESSAGE)
  }

  // 5. Forward. Only the headers Anthropic needs; the caller's x-api-key is discarded.
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': anthropicKey,
    'anthropic-version': req.headers.get('anthropic-version') || ANTHROPIC_VERSION,
  }
  const beta = req.headers.get('anthropic-beta')
  if (beta) headers['anthropic-beta'] = beta

  const upstream = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await upstream.text()
  if (!upstream.ok) {
    // Pass Anthropic's error through unchanged, status included, so the SDK's typed
    // error classes (RateLimitError etc.) keep working.
    return new Response(text, { status: upstream.status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  let res: any
  try {
    res = JSON.parse(text)
  } catch {
    return apiError(502, 'api_error', 'Upstream returned a non-JSON response.')
  }

  const usage = res.usage || {}
  await admin.from('model_spend').insert({
    user_id: user.id,
    model: res.model || body.model,
    purpose,
    input_tokens: Number(usage.input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0),
    cached_tokens: Number(usage.cache_read_input_tokens || 0),
    output_tokens: Number(usage.output_tokens || 0),
    usd: costUsd(res.model || body.model, usage),
    cache_hit: false,
  })

  if (cacheKey) {
    const extraction = extractionFromResponse(res)
    if (extraction) {
      await admin.from('evidence_cache').upsert({
        ...cacheKey,
        extraction,
        model: res.model || body.model,
        created_by: user.id,
      }, { onConflict: 'pmid,extraction_version,source_hash', ignoreDuplicates: true })
    }
  }

  return new Response(text, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'x-verastar-cache': cacheKey ? 'miss' : 'none' } })
})
