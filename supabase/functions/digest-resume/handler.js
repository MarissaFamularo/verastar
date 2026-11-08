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
// invalid-link result and nothing changes. Pure except for `admin`; index.ts binds the runtime.

import { verifyResume } from '../_shared/unsubscribe.js'
import { digestActionResponse, recordDigestAction } from '../_shared/digestAction.js'

export async function handleResume(req, { admin, secret, appUrl = '', now = () => new Date() }) {
  const reply = (code) => digestActionResponse(req, code, appUrl)
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  if (req.method !== 'GET' && req.method !== 'POST') return reply('not-allowed')
  if (!secret) return reply('resume-unconfigured')
  const url = new URL(req.url)
  const u = url.searchParams.get('u') || ''
  const t = url.searchParams.get('t') || ''
  if (!(await verifyResume(u, t, secret))) return reply('resume-invalid')

  const userId = u.toLowerCase()
  const at = now().toISOString()
  try {
    const { data: rows, error } = await admin.from('digest_schedules')
      .update({ paused_at: null, unopened_streak: 0, engaged_at: at, updated_at: at })
      .eq('user_id', userId)
      .select('user_id,enabled')
    if (error || !Array.isArray(rows)) return reply('retry')
    if (!rows.length) return reply('resume-missing')
    if (rows.length !== 1 || rows[0].user_id !== userId || typeof rows[0].enabled !== 'boolean') return reply('retry')
    await recordDigestAction(admin, { user_id: userId, type: 'digest_resume_clicked', payload: { via: req.method === 'POST' ? 'post' : 'link' } })
    return reply(rows[0].enabled ? 'resumed' : 'resume-disabled')
  } catch { return reply('retry') }
}
