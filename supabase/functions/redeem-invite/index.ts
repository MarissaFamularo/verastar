// supabase/functions/redeem-invite/index.ts — turn an invite code into sponsored access.
//
// POST { code } with the user's Supabase JWT. The code is checked and consumed by the
// redeem_sponsor_invite database function under the service role, atomically, so two
// redemptions of the last use cannot both succeed and a guessed code learns nothing beyond
// "invalid". Rate limited per user by the events table: five attempts per hour. The user id
// is always the verified JWT's; the state contract (already/revoked/paused/full/...) is in
// docs/SPENDING_CONTRACT.md § Invitations.

import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const EXPECTED_CONTRACT = '2026-10-09.spending-v2'
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceKey) return json(500, { error: 'not configured' })

  const auth = req.headers.get('authorization') || ''
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: auth } } })
  const { data: userData } = await userClient.auth.getUser()
  const user = userData?.user
  if (!user) return json(401, { error: 'Sign in first.' })

  let code = ''
  try {
    code = String((await req.json())?.code || '').trim()
  } catch {
    /* fall through */
  }
  if (!code || code.length > 64) return json(400, { status: 'invalid' })

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  // Cutover guard: this function may be deployed before the spending migration. Until the
  // database reports the new contract, the old redeem function (which could reactivate a
  // revoked account) must not be reached, so redemption is refused as paused.
  const { data: contract, error: contractError } = await admin.rpc('spending_contract_version')
  if (contractError || contract !== EXPECTED_CONTRACT) return json(503, { status: 'paused' })
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count, error: countError } = await admin.from('events').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('type', 'invite_attempt').gte('ts', since)
  // The rate limit fails closed: an unreadable attempt count is not zero attempts.
  if (countError) return json(503, { status: 'error' })
  if ((count || 0) >= 5) return json(429, { status: 'slow_down' })
  const { error: logError } = await admin.from('events').insert({ user_id: user.id, type: 'invite_attempt', payload: {} })
  if (logError) return json(503, { status: 'error' })

  const { data, error } = await admin.rpc('redeem_sponsor_invite', { p_code: code, p_user_id: user.id })
  if (error) return json(500, { status: 'error' })
  if (data?.status === 'enrolled' || data?.status === 'already') {
    await admin.from('events').insert({ user_id: user.id, type: 'sponsored_enrolled', payload: { cohort: data.cohort, status: data.status } })
  }
  return json(200, data)
})
