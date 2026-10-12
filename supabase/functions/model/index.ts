// supabase/functions/model/index.ts — the sponsored model proxy (Deno entry).
//
// All behavior lives in ./handler.js (tested under vitest with fakes); this file binds it to
// the platform. Every paid attempt goes through ../_shared/spending.js: reserve in the
// database before dispatch, one provider attempt, then settle or mark ambiguous.
// Cap and budget values live in the database (sponsor_config, sponsored_accounts).
//
// Secrets: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// (the last three are injected by the platform).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { handleModelRequest, CORS } from './handler.js'
import { anthropicDispatch, makeRpcLedger, resolveProviderUrl } from '../_shared/spending.js'

Deno.serve((req) => {
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!anthropicKey || !supabaseUrl || !anonKey || !serviceKey) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Proxy is not configured.' } }), {
      status: 500, headers: { ...CORS, 'content-type': 'application/json', 'x-should-retry': 'false' },
    })
  }
  const provider = resolveProviderUrl(Deno.env.toObject())
  if (!provider.ok) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: provider.error } }), {
      status: 500, headers: { ...CORS, 'content-type': 'application/json', 'x-should-retry': 'false' },
    })
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  return handleModelRequest(req, {
    admin,
    ledger: makeRpcLedger(admin),
    dispatch: anthropicDispatch(anthropicKey, fetch, provider.url),
    getUser: async (authHeader: string) => {
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
      const { data, error } = await userClient.auth.getUser()
      return error ? null : data?.user ?? null
    },
  })
})
