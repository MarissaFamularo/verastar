// supabase/functions/_shared/unsubscribe.js — the signed one-click unsubscribe link.
//
// A link in every digest email that works signed out: GET or POST (RFC 8058 one-click) to
// digest-unsubscribe with the account id and an HMAC of it under DIGEST_UNSUBSCRIBE_SECRET.
// Whoever holds the email holds the link, which is the point; nobody without the secret
// can forge one for another account. Web Crypto only, so Deno and Node share this file.

const enc = new TextEncoder()

async function hmacHex(secret, message) {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// One account-scoped token per purpose. The purpose prefix keeps an unsubscribe token from
// working as a resume token and the other way round.
async function signFor(purpose, userId, secret) {
  if (!secret || String(secret).length < 16) throw new Error(`${purpose} secret is missing or too short`)
  if (!UUID.test(String(userId))) throw new Error(`${purpose}: user id is not a uuid`)
  return hmacHex(secret, `digest-${purpose}:${String(userId).toLowerCase()}`)
}

async function verifyFor(purpose, userId, token, secret) {
  try {
    if (!secret || !UUID.test(String(userId || ''))) return false
    const expected = await signFor(purpose, userId, secret)
    const given = String(token || '').toLowerCase()
    if (given.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
    return diff === 0
  } catch {
    return false
  }
}

export async function signUnsubscribe(userId, secret) {
  if (!secret || String(secret).length < 16) throw new Error('unsubscribe secret is missing or too short')
  if (!UUID.test(String(userId))) throw new Error('unsubscribe: user id is not a uuid')
  return hmacHex(secret, `digest-unsubscribe:${String(userId).toLowerCase()}`)
}

// The pause email's "No, don't pause me" button (digest-resume). Same secret, own prefix.
export const signResume = (userId, secret) => signFor('resume', userId, secret)
export const verifyResume = (userId, token, secret) => verifyFor('resume', userId, token, secret)
export async function resumeUrl(functionsBase, userId, secret) {
  const base = String(functionsBase || '').replace(/\/+$/, '')
  if (!base) throw new Error('resume: functions base url is required')
  const t = await signResume(userId, secret)
  return `${base}/digest-resume?u=${encodeURIComponent(String(userId).toLowerCase())}&t=${t}`
}

// True only for a well-formed id and a token that matches it. Never throws.
export async function verifyUnsubscribe(userId, token, secret) {
  try {
    if (!secret || !UUID.test(String(userId || ''))) return false
    const expected = await signUnsubscribe(userId, secret)
    const given = String(token || '').toLowerCase()
    if (given.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
    return diff === 0
  } catch {
    return false
  }
}

// The link for one account. `functionsBase` is the project's functions root, e.g.
// https://<ref>.supabase.co/functions/v1
export async function unsubscribeUrl(functionsBase, userId, secret) {
  const base = String(functionsBase || '').replace(/\/+$/, '')
  if (!base) throw new Error('unsubscribe: functions base url is required')
  const t = await signUnsubscribe(userId, secret)
  return `${base}/digest-unsubscribe?u=${encodeURIComponent(String(userId).toLowerCase())}&t=${t}`
}
