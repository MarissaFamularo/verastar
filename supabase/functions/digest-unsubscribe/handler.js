// supabase/functions/digest-unsubscribe/handler.js — stop the digest email for one account.
//
// GET  /digest-unsubscribe?u=<user id>&t=<token>   the link in the email footer
// POST same query, body "List-Unsubscribe=One-Click"  what Gmail and Apple Mail send for
//      the native unsubscribe button (RFC 8058); the gateway does not need a JWT.
//
// A valid token turns email_digest off on the account's schedule row (creating a row that
// is off in every way when there is none) and records digest_email_unsubscribed. The
// in-app digest keeps running; Settings turns the email back on. A bad token is a plain
// 400 page and nothing changes. Pure except for `admin`; index.ts binds the runtime.

import { verifyUnsubscribe } from '../_shared/unsubscribe.js'

const page = (status, title, body, appUrl) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:40px 16px;background:#fff;color:#111;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;"><h1 style="font-size:20px;margin:0 0 12px 0;">${title}</h1><p>${body}</p>
${appUrl ? `<p><a href="${appUrl}">Open Verastar</a></p>` : ''}</div></body></html>`, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
})

export async function handleUnsubscribe(req, { admin, secret, appUrl = '' }) {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } })
  if (req.method !== 'GET' && req.method !== 'POST') return page(405, 'Not allowed', 'This address only answers the unsubscribe link.', appUrl)
  if (!secret) return page(500, 'Not configured', 'Unsubscribe is not set up on this server yet. Turn off "Email me the digest" under Settings in Verastar instead.', appUrl)
  const url = new URL(req.url)
  const u = url.searchParams.get('u') || ''
  const t = url.searchParams.get('t') || ''
  if (!(await verifyUnsubscribe(u, t, secret))) return page(400, 'This link is not valid', 'It may have been cut short by your mail app. You can also turn off "Email me the digest" under Settings in Verastar.', appUrl)

  const userId = u.toLowerCase()
  const now = new Date().toISOString()
  const { data: updated, error } = await admin.from('digest_schedules').update({ email_digest: false, updated_at: now }).eq('user_id', userId).select('user_id')
  if (error) return page(503, 'Please try again', 'The server could not save that just now. The link keeps working; try it again in a minute.', appUrl)
  if (!updated?.length) {
    const { error: insertError } = await admin.from('digest_schedules').insert({ user_id: userId, enabled: false, email_digest: false })
    if (insertError && !/duplicate|23505/.test(String(insertError.message || insertError.code))) return page(503, 'Please try again', 'The server could not save that just now. The link keeps working; try it again in a minute.', appUrl)
  }
  await admin.from('events').insert({ user_id: userId, type: 'digest_email_unsubscribed', payload: { via: req.method === 'POST' ? 'one-click' : 'link' } }).then(() => {}, () => {})
  return page(200, 'Unsubscribed', 'You will not get the Verastar digest by email any more. The digest still runs in the app. To get the email again, turn on "Email me the digest" under Settings.', appUrl)
}
