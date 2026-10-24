// Sends a one-time code to the account behind a Gmail alias ticket, then checks
// that code. The stored address is an argument to the injected database calls
// and is never copied onto the HTTP response.
//
// A verify ticket answers at most MAX_VERIFY_FAILURES wrong codes. Each refusal is
// counted on the ticket (deps.failVerify, 20261014122000_gmail_otp_failures.sql);
// the fifth deletes it, and every later check is refused before Auth is asked.
//
// A send carries the browser's CAPTCHA token through to Supabase Auth. With CAPTCHA
// protection on, Auth refuses an OTP request from this function's anon client
// without a valid token, the same as it refuses one from the browser.

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_VERIFY_FAILURES = 5
// Turnstile tokens are at most 2048 characters; hCaptcha's are shorter.
export const MAX_CAPTCHA_TOKEN = 4096

// '' when absent; null when present but malformed (refused before the ticket is spent).
export function captchaTokenFrom(payload) {
  const value = payload?.captchaToken
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > MAX_CAPTCHA_TOKEN || /\s/.test(value)) return null
  return value
}

export function safeRedirect(value) {
  if (typeof value !== 'string' || value.length > 200) return ''
  try {
    const url = new URL(value)
    if (url.username || url.password) return ''
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return url.origin
  } catch {
    return ''
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

export async function handleGmailCanonicalOtp(req, deps) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { status: 'error' })
  let payload = null
  try {
    payload = await req.json()
  } catch {
    payload = null
  }
  if (payload?.action === 'send') return sendTicket(payload, deps)
  if (payload?.action === 'verify') return verifyTicket(payload, deps)
  return json(400, { status: 'error' })
}

async function sendTicket(payload, deps) {
  const ticket = typeof payload?.ticket === 'string' ? payload.ticket : ''
  if (!UUID.test(ticket)) return json(400, { status: 'error' })
  // The token is checked by Supabase Auth inside sendOtp, which is the only check:
  // a Turnstile token is single-use, so verifying it here first would spend it.
  const captchaToken = captchaTokenFrom(payload)
  if (captchaToken === null) return json(400, { status: 'captcha' })
  const email = await deps.takeSend(ticket)
  if (typeof email !== 'string' || !email.includes('@')) return json(400, { status: 'error' })
  const sent = await deps.sendOtp(email, safeRedirect(payload?.redirectTo), captchaToken)
  if (sent?.captcha) return json(400, { status: 'captcha' })
  if (!sent?.ok) return json(502, { status: 'error' })
  const verifyTicket = await deps.keepVerify(email)
  if (typeof verifyTicket !== 'string' || !UUID.test(verifyTicket)) return json(502, { status: 'error' })
  return json(200, { sent: true, verifyTicket })
}

async function verifyTicket(payload, deps) {
  const verifyTicketValue = typeof payload?.verifyTicket === 'string' ? payload.verifyTicket : ''
  const code = String(payload?.code || '').trim()
  if (!UUID.test(verifyTicketValue) || !/^[0-9]{6,10}$/.test(code)) return json(400, { status: 'invalid' })
  const email = await deps.readVerify(verifyTicketValue)
  if (typeof email !== 'string' || !email.includes('@')) return json(400, { status: 'invalid' })
  const session = await deps.verifyOtp(email, code)
  if (!session?.access_token || !session?.refresh_token) {
    // Count the miss on the ticket. A counter that cannot be recorded burns the ticket
    // too (fail closed): the caller starts over from the alias hint.
    let left = 0
    try {
      left = Number(await deps.failVerify(verifyTicketValue))
    } catch {
      left = 0
    }
    if (!Number.isFinite(left) || left <= 0) {
      try { await deps.consumeVerify(verifyTicketValue) } catch { /* already gone */ }
      return json(400, { status: 'locked' })
    }
    return json(400, { status: 'invalid' })
  }
  try {
    await deps.consumeVerify(verifyTicketValue)
  } catch {
    // The code already checked out. Dropping the ticket is cleanup.
  }
  return json(200, {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })
}
