// supabase/functions/digest-resume/handler.js — the pause email's "No, don't pause me"
// button.
//
// GET or POST /digest-resume?u=<user id>&t=<token>
//
// A valid token clears paused_at, resets unopened_streak to 0, stamps engaged_at (the
// button is a click from the reader, so the digest it replaces counts as read), and records
// digest_resume_clicked. The next scheduled tick builds a digest as usual. A schedule the
// reader switched off in Settings stays off; the page says so. HEAD changes nothing, so a
// link checker that only probes the button does not resume anyone. A bad token is a plain
// 400 page and nothing changes. Pure except for `admin`; index.ts binds the runtime.

import { verifyResume } from '../_shared/unsubscribe.js'

const page = (status, title, body, appUrl) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:40px 16px;background:#fff;color:#111;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;"><h1 style="font-size:20px;margin:0 0 12px 0;">${title}</h1><p>${body}</p>
${appUrl ? `<p><a href="${appUrl}">Open Verastar</a></p>` : ''}</div></body></html>`, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
})

const RETRY = 'The server could not save that just now. The button keeps working; try it again in a minute.'

export async function handleResume(req, { admin, secret, appUrl = '', now = () => new Date() }) {
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  if (req.method !== 'GET' && req.method !== 'POST') return page(405, 'Not allowed', 'This address only answers the button in the pause email.', appUrl)
  if (!secret) return page(500, 'Not configured', 'This button is not set up on this server yet. Open Verastar, or press "Run now" under Settings, and your digest starts again.', appUrl)
  const url = new URL(req.url)
  const u = url.searchParams.get('u') || ''
  const t = url.searchParams.get('t') || ''
  if (!(await verifyResume(u, t, secret))) return page(400, 'This link is not valid', 'It may have been cut short by your mail app. Open Verastar, or press "Run now" under Settings, and your digest starts again.', appUrl)

  const userId = u.toLowerCase()
  const at = now().toISOString()
  const { data: rows, error } = await admin.from('digest_schedules')
    .update({ paused_at: null, unopened_streak: 0, engaged_at: at, updated_at: at })
    .eq('user_id', userId)
    .select('user_id, enabled')
  if (error) return page(503, 'Please try again', RETRY, appUrl)
  await admin.from('events').insert({ user_id: userId, type: 'digest_resume_clicked', payload: { via: req.method === 'POST' ? 'post' : 'link' } }).then(() => {}, () => {})
  if (rows?.length && rows[0].enabled === false) {
    return page(200, 'Thanks. You are not paused', 'Automatic runs are switched off under Settings, so no digest is built until you turn "Run automatically" back on.', appUrl)
  }
  return page(200, 'Thanks. Your digest is back on', 'Your next digest arrives at your usual hour.', appUrl)
}
