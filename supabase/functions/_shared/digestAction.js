// Browser confirmations are served by the app, not Supabase (which rewrites HTML
// responses to text/plain). Only an allowlisted outcome crosses the redirect; never
// forward the account id, signed token, database error, or a caller-supplied URL.
export const DIGEST_ACTION_RESULTS = {
  resumed: { status: 200, title: 'Thanks. Your digest is back on', body: 'The pause is cleared. Your next automatic digest will run at your usual scheduled time.' },
  'resume-disabled': { status: 200, title: 'Thanks. You are not paused', body: 'Automatic runs are switched off under Settings, so no digest is built until you turn "Run automatically" back on.' },
  'resume-missing': { status: 404, title: 'No digest schedule found', body: 'We could not find a digest schedule for this link. Nothing was resumed. Sign in to the account that received the email and check your digest settings.' },
  'resume-invalid': { status: 400, title: 'This link is not valid', body: 'It may have been cut short by your mail app. Open Verastar and check your digest settings to resume.' },
  'resume-unconfigured': { status: 500, title: 'Not configured', body: 'This button is not set up on this server yet. Open Verastar and check your digest settings to resume.' },
  unsubscribed: { status: 200, title: 'Unsubscribed', body: 'You will not get the Verastar digest by email any more. Your in-app digest settings have not changed. To get the email again, turn on "Email me the digest" under Settings.' },
  'unsubscribe-invalid': { status: 400, title: 'This link is not valid', body: 'It may have been cut short by your mail app. You can also turn off "Email me the digest" under Settings in Verastar.' },
  'unsubscribe-unconfigured': { status: 500, title: 'Not configured', body: 'Unsubscribe is not set up on this server yet. Turn off "Email me the digest" under Settings in Verastar instead.' },
  retry: { status: 503, title: 'Please try again', body: 'The server could not confirm that your change was saved. Return to the email and try it again in a minute, or check your digest settings in Verastar.' },
  'not-allowed': { status: 405, title: 'Not allowed', body: 'This address only answers the link in the digest email.' },
  unknown: { status: 400, title: 'Check your digest settings', body: 'This page does not confirm a change to your digest. Open the link in your email, or sign in to Verastar to check your settings.' },
}

export const digestActionResult = (code) => Object.hasOwn(DIGEST_ACTION_RESULTS, code) ? DIGEST_ACTION_RESULTS[code] : DIGEST_ACTION_RESULTS.unknown

export function digestActionResponse(req, code, appUrl = '') {
  const result = digestActionResult(code)
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Type': 'text/plain; charset=utf-8' }
  // RFC 8058 mail-client POSTs need a direct status, never a redirect to HTML.
  if (req.method === 'GET' && appUrl) {
    try {
      const location = new URL(appUrl)
      if (!['https:', 'http:'].includes(location.protocol) || location.username || location.password) throw new Error('Invalid app URL')
      location.pathname = `${location.pathname.replace(/\/+$/, '')}/digest-status.html`
      location.search = ''
      location.hash = ''
      location.searchParams.set('result', Object.hasOwn(DIGEST_ACTION_RESULTS, code) ? code : 'unknown')
      return new Response(null, { status: 303, headers: { ...headers, Location: location.href } })
    } catch { /* A misconfigured frontend must not hide the saved outcome. */ }
  }
  return new Response(`${result.title}\n\n${result.body}\n`, { status: result.status, headers })
}

// Analytics are best effort, not part of the user's requested state change.
export async function recordDigestAction(admin, event) {
  try { await admin.from('events').insert(event) } catch { /* The change was already saved. */ }
}
