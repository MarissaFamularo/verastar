// lib/emailCode.js — one-time email code sign-in, shared by onboarding and settings.
//
// A wrong, expired, or already-used code must stay on the code screen with a
// readable error. Reloading here is what blanked the page and dumped people on
// the marketing landing with no session and no message: verify resolved without
// a user, and the screen treated that as success. A hung check gets its own
// timeout message instead of spinning until the page gives up.

import { useRef, useState } from 'react'
import { sendMagicLink, verifyEmailCode } from './supabase.js'

export const EMAIL_CODE_TIMEOUT_MS = 8000

export const EMAIL_CODE_MESSAGES = {
  invalid: 'That code is invalid or expired. It may already have been used. Send a new code and try again.',
  timeout: 'Checking the code timed out, so you are not signed in. Try the code again, or send a new code.',
  network: 'We couldn\u2019t reach sign-in just now. Try the code again, or send a new code.',
}

export function emailCodeFailureKind(err) {
  if (!err) return 'invalid'
  if (err.code === 'timeout' || err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout'
  const raw = `${err.code || ''} ${err.status || ''} ${err.message || err}`.toLowerCase()
  if (/timeout|timed out|abort/.test(raw)) return 'timeout'
  if (/failed to fetch|network|load failed|offline|networkerror|econn|enotfound/.test(raw)) return 'network'
  return 'invalid'
}

export function emailCodeFailureMessage(err) {
  return EMAIL_CODE_MESSAGES[emailCodeFailureKind(err)]
}

// Drop the onboarding hash so a successful sign-in boots at the app root.
export function reloadAfterSignIn(loc = typeof window !== 'undefined' ? window.location : null) {
  if (!loc) return
  const path = `${loc.pathname || '/'}${loc.search || ''}`
  if (typeof loc.assign === 'function') loc.assign(path)
  else if (typeof loc.reload === 'function') loc.reload()
}

// Resolves { ok: true, user } or { ok: false, kind, message }. Never reloads.
// A late session after the timeout still calls onLateSession so a slow success
// can enter the app, but a late failure cannot.
export async function verifyEmailCodeForSignIn(email, code, {
  timeoutMs = EMAIL_CODE_TIMEOUT_MS,
  verify = verifyEmailCode,
  onLateSession,
} = {}) {
  const pending = Promise.resolve().then(() => verify(email, code))
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false,
      kind: 'timeout',
      message: EMAIL_CODE_MESSAGES.timeout,
    }), timeoutMs)
  })
  try {
    const raced = await Promise.race([
      pending.then(
        (user) => {
          if (!user) return { ok: false, kind: 'invalid', message: EMAIL_CODE_MESSAGES.invalid }
          return { ok: true, user }
        },
        (err) => {
          const kind = emailCodeFailureKind(err)
          return { ok: false, kind, message: EMAIL_CODE_MESSAGES[kind] }
        },
      ),
      timeout,
    ])
    if (!raced.ok && raced.kind === 'timeout' && onLateSession) {
      pending.then((user) => { if (user) onLateSession(user) }).catch(() => {})
    }
    return raced
  } finally {
    clearTimeout(timer)
  }
}

export function useEmailCodeSignIn() {
  const attempt = useRef(0)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sendState, setSendState] = useState('idle') // idle | sending | sent | error
  const [sendError, setSendError] = useState('')
  const [verifyState, setVerifyState] = useState('idle') // idle | verifying | error
  const [verifyError, setVerifyError] = useState('')
  const [resending, setResending] = useState(false)
  const [resendNote, setResendNote] = useState('')

  async function send(event) {
    event?.preventDefault()
    if (!email.trim() || sendState === 'sending') return
    setSendState('sending')
    setSendError('')
    try {
      await sendMagicLink(email.trim())
      setSendState('sent')
    } catch (err) {
      setSendError(err?.message || String(err))
      setSendState('error')
    }
  }

  async function verify(event) {
    event?.preventDefault()
    const trimmed = code.trim()
    if (!trimmed || verifyState === 'verifying') return
    const id = ++attempt.current
    setVerifyState('verifying')
    setVerifyError('')
    setResendNote('')
    const result = await verifyEmailCodeForSignIn(email.trim(), trimmed, {
      onLateSession: () => { if (id === attempt.current) reloadAfterSignIn() },
    })
    if (id !== attempt.current) return
    if (!result.ok) {
      setVerifyError(result.message)
      setVerifyState('error')
      return
    }
    reloadAfterSignIn()
  }

  async function resend() {
    if (!email.trim() || resending) return
    ++attempt.current
    setResending(true)
    setVerifyState('idle')
    setVerifyError('')
    setResendNote('')
    setCode('')
    try {
      await sendMagicLink(email.trim())
      setSendState('sent')
      setResendNote('A new code is on its way.')
    } catch (err) {
      setSendState('sent')
      setVerifyError(err?.message || 'We couldn\u2019t send a new code. Try again in a moment.')
      setVerifyState('error')
    } finally {
      setResending(false)
    }
  }

  function reset() {
    ++attempt.current
    setSendState('idle')
    setSendError('')
    setVerifyState('idle')
    setVerifyError('')
    setResendNote('')
    setResending(false)
    setCode('')
  }

  return {
    email, setEmail, code, setCode,
    sendState, sendError, verifyState, verifyError,
    resending, resendNote,
    send, verify, resend, reset,
  }
}
