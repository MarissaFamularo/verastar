// supabase/functions/gmail-canonical-otp/index.ts
//
// Claims a Gmail alias ticket and sends the one-time code to the stored account.
// Callers are signed out, so they send the anon key. The service role is used
// only for the ticket functions, which anon cannot execute. shouldCreateUser
// stays false: this path signs in an account that already exists. The browser's
// CAPTCHA token rides along to Auth, which verifies it (handler.js).

import { createClient } from '@supabase/supabase-js'
import { CORS, handleGmailCanonicalOtp } from './handler.js'

function isCaptchaFailure(error: { code?: string, message?: string } | null): boolean {
  if (!error) return false
  return error.code === 'captcha_failed' || /captcha/i.test(error.message || '')
}

function jsonError() {
  return new Response(JSON.stringify({ status: 'error' }), {
    status: 500,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceKey) return jsonError()

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } })

  return handleGmailCanonicalOtp(req, {
    takeSend: async (ticket: string) => {
      const { data, error } = await admin.rpc('gmail_alias_take_send', { p_ticket: ticket })
      return error || typeof data !== 'string' ? '' : data
    },
    keepVerify: async (email: string) => {
      const { data, error } = await admin.rpc('gmail_alias_keep_verify', { p_email: email })
      return error || typeof data !== 'string' ? '' : data
    },
    readVerify: async (ticket: string) => {
      const { data, error } = await admin.rpc('gmail_alias_read_verify', { p_ticket: ticket })
      return error || typeof data !== 'string' ? '' : data
    },
    consumeVerify: async (ticket: string) => {
      await admin.rpc('gmail_alias_consume_verify', { p_ticket: ticket })
    },
    failVerify: async (ticket: string) => {
      const { data, error } = await admin.rpc('gmail_alias_fail_verify', { p_ticket: ticket })
      return error || typeof data !== 'number' ? 0 : data
    },
    sendOtp: async (email: string, redirectTo: string, captchaToken: string) => {
      const options: { shouldCreateUser: boolean, emailRedirectTo?: string, captchaToken?: string } = { shouldCreateUser: false }
      if (redirectTo) options.emailRedirectTo = redirectTo
      // Auth verifies the token (CAPTCHA protection is project-wide and applies to
      // this anon client too). Do not verify it here first: tokens are single-use.
      if (captchaToken) options.captchaToken = captchaToken
      const { error } = await anon.auth.signInWithOtp({ email, options })
      return { ok: !error, captcha: isCaptchaFailure(error) }
    },
    verifyOtp: async (email: string, code: string) => {
      const { data, error } = await anon.auth.verifyOtp({ email, token: code, type: 'email' })
      if (error || !data?.session?.access_token || !data.session.refresh_token) return null
      return {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      }
    },
  })
})
