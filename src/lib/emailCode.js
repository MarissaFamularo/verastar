// lib/emailCode.js — one-time email code sign-in, shared by onboarding and settings.
//
// A wrong, expired, or already-used code must stay on the code screen with a
// readable error. Reloading here is what blanked the page and dumped people on
// the marketing landing with no session and no message: verify resolved without
// a user, and the screen treated that as success. A hung check gets its own
// timeout message instead of spinning until the page gives up.

import { useRef, useState } from 'react'
import { sendMagicLink, supabase, verifyEmailCode } from './supabase.js'

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

// A Supabase getSession() payload, a session, or a user. Null when nobody is signed in.
export async function sessionUserFrom(getSession) {
  if (typeof getSession !== 'function') return null
  try {
    const value = await getSession()
    if (!value) return null
    if (value.data && Object.prototype.hasOwnProperty.call(value.data, 'session')) return value.data.session?.user || null
    if (value.session) return value.session.user || null
    if (value.user?.id) return value.user
    if (value.id) return value
    return null
  } catch {
    return null
  }
}

function defaultGetSession() {
  if (!supabase?.auth?.getSession) return null
  return supabase.auth.getSession()
}

// Resolves { ok: true, user } or { ok: false, kind, message }. Never reloads.
// The code check itself keeps running after the timeout. A session that shows up
// then — or that is already present when a check fails — is a successful sign-in.
// A late failure cannot become a success.
export async function verifyEmailCodeForSignIn(email, code, {
  timeoutMs = EMAIL_CODE_TIMEOUT_MS,
  verify = verifyEmailCode,
  getSession = defaultGetSession,
  onLateSession,
  onSettled,
} = {}) {
  const pending = Promise.resolve().then(() => verify(email, code))
  let timer
  let timedOut = false
  let honored = false
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({
        ok: false,
        kind: 'timeout',
        message: EMAIL_CODE_MESSAGES.timeout,
      })
    }, timeoutMs)
  })
  const interpreted = pending.then(
    async (user) => {
      const sessionUser = user || await sessionUserFrom(getSession)
      if (!sessionUser) return { ok: false, kind: 'invalid', message: EMAIL_CODE_MESSAGES.invalid }
      return { ok: true, user: sessionUser }
    },
    async (err) => {
      const sessionUser = await sessionUserFrom(getSession)
      if (sessionUser) return { ok: true, user: sessionUser }
      const kind = emailCodeFailureKind(err)
      return { ok: false, kind, message: EMAIL_CODE_MESSAGES[kind] }
    },
  )
  interpreted.then((result) => {
    if (timedOut && result?.ok && !honored) {
      honored = true
      onLateSession?.(result.user)
    }
    onSettled?.(result)
  }).catch(() => { onSettled?.(null) })
  try {
    let outcome = await Promise.race([interpreted, timeout])
    // Any failure, including the timeout, yields to a session that already exists.
    if (!outcome.ok) {
      const sessionUser = await sessionUserFrom(getSession)
      if (sessionUser) outcome = { ok: true, user: sessionUser }
    }
    if (outcome.ok) honored = true
    return outcome
  } finally {
    clearTimeout(timer)
  }
}

export function useEmailCodeSignIn() {
  const attempt = useRef(0)
  const flight = useRef(null)
  const entered = useRef(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sendState, setSendState] = useState('idle') // idle | sending | sent | error
  const [sendError, setSendError] = useState('')
  const [verifyState, setVerifyState] = useState('idle') // idle | verifying | error
  const [verifyError, setVerifyError] = useState('')
  const [pending, setPending] = useState(false)
  const [resending, setResending] = useState(false)
  const [resendNote, setResendNote] = useState('')

  function enter() {
    if (entered.current) return
    entered.current = true
    reloadAfterSignIn()
  }

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
    // One verifyOtp at a time. A retry while the first request is still in flight
    // (including after the 8s timeout) would burn the code and then report it invalid.
    if (!trimmed || flight.current) return
    const id = ++attempt.current
    let release = () => {}
    const gate = new Promise((resolve) => { release = resolve })
    flight.current = gate
    setPending(true)
    setVerifyState('verifying')
    setVerifyError('')
    setResendNote('')
    try {
      const result = await verifyEmailCodeForSignIn(email.trim(), trimmed, {
        onLateSession: () => enter(),
        onSettled: (settled) => {
          if (flight.current === gate) flight.current = null
          release()
          if (settled?.ok) {
            enter()
            return
          }
          if (id === attempt.current && settled && !settled.ok) {
            setVerifyError(settled.message)
            setVerifyState('error')
          }
          setPending(false)
        },
      })
      if (id !== attempt.current) return
      if (!result.ok) {
        setVerifyError(result.message)
        setVerifyState('error')
        if (result.kind !== 'timeout') setPending(false)
        return
      }
      enter()
    } catch (err) {
      if (flight.current === gate) flight.current = null
      release()
      setPending(false)
      if (id !== attempt.current) return
      setVerifyError(err?.message || EMAIL_CODE_MESSAGES.network)
      setVerifyState('error')
    }
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
    pending, verifyBusy: pending || verifyState === 'verifying',
    resending, resendNote,
    send, verify, resend, reset,
  }
}
