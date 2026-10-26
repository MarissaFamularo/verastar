// supabase/functions/digest-resume/index.ts — the pause email button's runtime binding.
// verify_jwt = false (supabase/config.toml): the button is clicked signed out from a mail
// app. The token in the link is the only credential.
// Secrets: DIGEST_UNSUBSCRIBE_SECRET (shared with digest-run, which signs the button; the
// resume token uses its own "digest-resume:" prefix); SUPABASE_* injected by the platform.
// Optional APP_URL for the page's link.

import { createClient } from '@supabase/supabase-js'
import { handleResume } from './handler.js'
import { DEFAULT_APP_URL } from '../_shared/digestEmail.js'

Deno.serve((req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return new Response('not configured', { status: 500 })
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  return handleResume(req, { admin, secret: Deno.env.get('DIGEST_UNSUBSCRIBE_SECRET') || '', appUrl: Deno.env.get('APP_URL') || DEFAULT_APP_URL })
})
