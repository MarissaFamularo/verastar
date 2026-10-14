// Sends a one-time code to the account behind a Gmail alias ticket, then checks
// that code. The stored address is an argument to the injected database calls
// and is never copied onto the HTTP response.

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  const email = await deps.takeSend(ticket)
  if (typeof email !== 'string' || !email.includes('@')) return json(400, { status: 'error' })
  const sent = await deps.sendOtp(email, safeRedirect(payload?.redirectTo))
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
  if (!session?.access_token || !session?.refresh_token) return json(400, { status: 'invalid' })
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
