// supabase/functions/digest-click/handler.js — record a click in a digest email, then go.
//
// GET  /digest-click?u=<user id>&k=<kind>&p=<paper id>&to=<destination>&t=<token>
//
// A valid link records digest_link_clicked (kind, paper id), stamps
// digest_schedules.engaged_at (the scheduler's sign that the reader is reading, so the
// unopened streak resets: digest-run/handler.js nextUnopenedStreak), and redirects to the
// signed destination. Recording is best effort: a database failure never strands the
// reader, who is redirected either way.
//
// HEAD redirects without recording anything, so a mail client or link checker that only
// probes the link does not count as the reader. A bad token is a plain 400 page with a link
// to the app and no redirect, since an unsigned destination could point anywhere.
// Pure except for `admin`; index.ts binds the runtime.

import { verifyClick } from '../_shared/digestClick.js'

const page = (status, title, body, appUrl) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:40px 16px;background:#fff;color:#111;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;"><h1 style="font-size:20px;margin:0 0 12px 0;">${title}</h1><p>${body}</p>
${appUrl ? `<p><a href="${appUrl}">Open Verastar</a></p>` : ''}</div></body></html>`, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
})

function redirect(to) {
  // no-referrer: the destination never sees the signed link.
  return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}

export async function handleClick(req, { admin, secret, appUrl = '', now = () => new Date() }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return page(405, 'Not allowed', 'This address only answers links in the Verastar digest email.', appUrl)
  if (!secret) return page(500, 'Not configured', 'Link tracking is not set up on this server yet.', appUrl)
  const url = new URL(req.url)
  const q = (k) => url.searchParams.get(k) || ''
  const click = await verifyClick({ userId: q('u'), kind: q('k'), paperId: q('p'), to: q('to'), token: q('t') }, secret)
  if (!click) return page(400, 'This link is not valid', 'It may have been cut short by your mail app. The paper is still in your digest in Verastar.', appUrl)
  if (req.method === 'HEAD') return redirect(click.to)

  const at = now().toISOString()
  try {
    await admin.from('events').insert({ user_id: click.userId, type: 'digest_link_clicked', payload: { paper_id: click.paperId, kind: click.kind } })
  } catch { /* best effort */ }
  try {
    await admin.from('digest_schedules').update({ engaged_at: at, updated_at: at }).eq('user_id', click.userId)
  } catch { /* best effort */ }
  return redirect(click.to)
}
