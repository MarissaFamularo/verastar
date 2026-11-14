// supabase/functions/digest-survey/index.ts — the email survey page's runtime binding.
// verify_jwt = false (supabase/config.toml): the page posts here signed out. The signed
// token in the link is the only credential.
// Secrets: DIGEST_UNSUBSCRIBE_SECRET (shared with digest-run, which signs the link; the
// survey token uses its own "digest-survey:" prefix); SUPABASE_* injected by the platform.

import { createClient } from '@supabase/supabase-js'
import { handleSurvey } from './handler.js'

Deno.serve((req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return new Response('not configured', { status: 500 })
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  return handleSurvey(req, { admin, secret: Deno.env.get('DIGEST_UNSUBSCRIBE_SECRET') || '' })
})
