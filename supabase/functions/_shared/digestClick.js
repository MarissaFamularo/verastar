// supabase/functions/_shared/digestClick.js — the signed click-through link.
//
// Every link in a digest email (PubMed, full text, "Open in Verastar") and the pause
// email's button goes through digest-click first: the account id, what kind of link it is,
// the paper id (when there is one) and the destination, plus an HMAC of all four. The
// function records the click, marks the account engaged, and redirects. Because the
// destination is signed, the function cannot be used to bounce anyone to an address of
// someone else's choosing, and nobody without the secret can mark another account engaged.
//
// Same secret and same construction as the unsubscribe link (./unsubscribe.js); the
// "digest-click:" prefix keeps the two kinds of token from standing in for each other.
// Web Crypto only, so Deno and Node share this file.

const enc = new TextEncoder()

async function hmacHex(secret, message) {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAPER_ID = /^[A-Za-z0-9._:/-]{0,128}$/

// What a link is: "paper" (the paper's citation, usually PubMed), "fulltext" (the
// open-access copy), "open" (the digest email's "Open in Verastar"), "pause-open" (the
// pause email's link to the app).
export const CLICK_KINDS = ['paper', 'fulltext', 'open', 'pause-open']

function destination(to) {
  try {
    const u = new URL(String(to))
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

function message({ userId, kind, paperId = '', to }) {
  return `digest-click:${String(userId).toLowerCase()}:${kind}:${paperId}:${to}`
}

// Throws on anything that should never be signed: a short secret, a non-uuid account, an
// unknown kind, an odd paper id, or a destination that is not an http(s) URL.
export async function signClick({ userId, kind, paperId = '', to }, secret) {
  if (!secret || String(secret).length < 16) throw new Error('click secret is missing or too short')
  if (!UUID.test(String(userId))) throw new Error('click: user id is not a uuid')
  if (!CLICK_KINDS.includes(kind)) throw new Error(`click: unknown kind ${kind}`)
  if (!PAPER_ID.test(String(paperId ?? ''))) throw new Error('click: paper id is malformed')
  const dest = destination(to)
  if (!dest) throw new Error('click: destination must be an http(s) url')
  return hmacHex(secret, message({ userId, kind, paperId: String(paperId ?? ''), to: dest }))
}

// The verified link, or null. Never throws. Returns the normalized destination so the
// function redirects to exactly what was signed.
export async function verifyClick({ userId, kind, paperId = '', to, token }, secret) {
  try {
    if (!secret || !UUID.test(String(userId || ''))) return null
    const dest = destination(to)
    if (!dest) return null
    const expected = await signClick({ userId, kind, paperId, to: dest }, secret)
    const given = String(token || '').toLowerCase()
    if (given.length !== expected.length) return null
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
    if (diff !== 0) return null
    return { userId: String(userId).toLowerCase(), kind, paperId: String(paperId ?? '') || null, to: dest }
  } catch {
    return null
  }
}

// The tracked link for one destination. `functionsBase` is the project's functions root,
// e.g. https://<ref>.supabase.co/functions/v1
export async function clickUrl(functionsBase, { userId, kind, paperId = '', to }, secret) {
  const base = String(functionsBase || '').replace(/\/+$/, '')
  if (!base) throw new Error('click: functions base url is required')
  const dest = destination(to)
  const t = await signClick({ userId, kind, paperId, to: dest }, secret)
  const q = new URLSearchParams({ u: String(userId).toLowerCase(), k: kind })
  if (paperId) q.set('p', String(paperId))
  q.set('to', dest)
  q.set('t', t)
  return `${base}/digest-click?${q.toString()}`
}
