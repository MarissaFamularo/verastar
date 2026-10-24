// Client for the Gmail alias one-time-code function. The ticket is opaque.
// This module never reads or returns the account address behind it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value)
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

function endpoint() {
  const env = import.meta.env || {}
  const base = String(env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.VITE_SUPABASE_ANON_KEY || ''
  if (!base || !key) return null
  return { url: `${base}/functions/v1/gmail-canonical-otp`, key }
}

async function post(body) {
  const dest = endpoint()
  if (!dest) throw new Error('Sign-in is not configured.')
  const res = await fetch(dest.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${dest.key}`,
      apikey: dest.key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  let out = null
  try { out = await res.json() } catch { out = null }
  return { ok: res.ok, body: out && typeof out === 'object' ? out : null }
}

// captchaToken is forwarded to the function, which hands it to Supabase Auth with
// the send. It is left off the body when CAPTCHA is not configured.
export async function sendCanonicalGmailCode({ ticket, redirectTo, captchaToken } = {}) {
  if (!isUuid(ticket)) return { ok: false }
  const request = {
    action: 'send',
    ticket,
    redirectTo: safeRedirect(redirectTo),
  }
  if (typeof captchaToken === 'string' && captchaToken) request.captchaToken = captchaToken
  const { ok, body } = await post(request)
  if (body?.status === 'captcha') return { ok: false, captcha: true }
  if (!ok || !isUuid(body?.verifyTicket)) return { ok: false }
  return { ok: true, verifyTicket: body.verifyTicket }
}

export async function verifyCanonicalGmailCode({ verifyTicket, code } = {}) {
  const token = String(code || '').trim()
  if (!isUuid(verifyTicket) || !/^[0-9]{6,10}$/.test(token)) {
    throw new Error('invalid')
  }
  const { ok, body } = await post({ action: 'verify', verifyTicket, code: token })
  const access = body?.access_token
  const refresh = body?.refresh_token
  if (!ok || typeof access !== 'string' || typeof refresh !== 'string' || !access || !refresh) {
    throw new Error('invalid')
  }
  return { access_token: access, refresh_token: refresh }
}
