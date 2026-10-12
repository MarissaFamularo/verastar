import { createClient } from '@supabase/supabase-js'
import { lookupNpi, validNpiInput } from '../_shared/npiMatch.js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'Content-Type': 'application/json' },
})
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { status: 'invalid' })
  const url = Deno.env.get('SUPABASE_URL')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anon || !service) return json(503, { status: 'unavailable' })
  const client = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('authorization') || '' } } })
  const { data } = await client.auth.getUser()
  if (!data?.user) return json(401, { status: 'signin' })
  let input
  try { input = await req.json() } catch { return json(400, { status: 'invalid' }) }
  if (!validNpiInput(input)) return json(400, { status: 'invalid' })
  const admin = createClient(url, service, { auth: { persistSession: false } })
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count, error } = await admin.from('events').select('id', { count: 'exact', head: true })
    .eq('user_id', data.user.id).eq('type', 'npi_attempt').gte('ts', since)
  if (error) return json(503, { status: 'unavailable' })
  if ((count || 0) >= 10) return json(429, { status: 'slow_down' })
  const { error: logError } = await admin.from('events').insert({ user_id: data.user.id, type: 'npi_attempt', payload: {} })
  if (logError) return json(503, { status: 'unavailable' })
  const result = await lookupNpi(input)
  if (result.status !== 'matched') return json(result.status === 'unavailable' ? 503 : 422, result)
  // app_metadata is server-owned; do not trust a profile or user_metadata flag.
  const { error: saveError } = await admin.auth.admin.updateUserById(data.user.id, {
    app_metadata: { ...data.user.app_metadata, npi_match: result.match },
  })
  if (saveError) return json(503, { status: 'unavailable' })
  return json(200, result)
})
