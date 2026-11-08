// supabase/functions/digest-unsubscribe/handler.js — stop the digest email for one account.
//
// GET  /digest-unsubscribe?u=<user id>&t=<token>   the link in the email footer
// POST same query, body "List-Unsubscribe=One-Click"  what Gmail and Apple Mail send for
//      the native unsubscribe button (RFC 8058); the gateway does not need a JWT.
//
// A valid token turns email_digest off on the account's schedule row (creating a row that
// is off in every way when there is none) and records digest_email_unsubscribed. The
// in-app digest keeps running; Settings turns the email back on. A bad token is a plain
// invalid-link result and nothing changes. Pure except for `admin`; index.ts binds the runtime.

import { verifyUnsubscribe } from '../_shared/unsubscribe.js'
import { digestActionResponse, recordDigestAction } from '../_shared/digestAction.js'

export async function handleUnsubscribe(req, { admin, secret, appUrl = '' }) {
  const reply = (code) => digestActionResponse(req, code, appUrl)
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } })
  if (req.method !== 'GET' && req.method !== 'POST') return reply('not-allowed')
  if (!secret) return reply('unsubscribe-unconfigured')
  const url = new URL(req.url)
  const u = url.searchParams.get('u') || ''
  const t = url.searchParams.get('t') || ''
  if (!(await verifyUnsubscribe(u, t, secret))) return reply('unsubscribe-invalid')

  const userId = u.toLowerCase()
  const now = new Date().toISOString()
  try {
    const updateEmail = () => admin.from('digest_schedules').update({ email_digest: false, updated_at: now }).eq('user_id', userId).select('user_id')
    const confirmed = (rows) => Array.isArray(rows) && rows.length === 1 && rows[0].user_id === userId
    const { data: updated, error } = await updateEmail()
    if (error || !Array.isArray(updated)) return reply('retry')
    if (!updated.length) {
      const { error: insertError } = await admin.from('digest_schedules').insert({ user_id: userId, enabled: false, email_digest: false })
      if (insertError) {
        if (insertError.code !== '23505') return reply('retry')
        // Settings (or a second click) may have inserted a row since our update.
        // A uniqueness conflict alone does not prove that its email flag is off.
        const { data: retried, error: retryError } = await updateEmail()
        if (retryError || !confirmed(retried)) return reply('retry')
      }
    } else if (!confirmed(updated)) return reply('retry')
    await recordDigestAction(admin, { user_id: userId, type: 'digest_email_unsubscribed', payload: { via: req.method === 'POST' ? 'one-click' : 'link' } })
    return reply('unsubscribed')
  } catch { return reply('retry') }
}
