// supabase/functions/digest-unsubscribe/index.ts — the unsubscribe link's runtime binding.
// verify_jwt = false (supabase/config.toml): the link is opened signed out, and mail clients
// POST to it with no headers of ours. The token in the link is the only credential.
// Secrets: DIGEST_UNSUBSCRIBE_SECRET (shared with digest-run, which signs the links);
// SUPABASE_* injected by the platform. Optional APP_URL for the page's link.

import { createClient } from '@supabase/supabase-js'
import { handleUnsubscribe } from './handler.js'
import { DEFAULT_APP_URL } from '../_shared/digestEmail.js'

Deno.serve((req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return new Response('not configured', { status: 500 })
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  return handleUnsubscribe(req, { admin, secret: Deno.env.get('DIGEST_UNSUBSCRIBE_SECRET') || '', appUrl: Deno.env.get('APP_URL') || DEFAULT_APP_URL })
})
