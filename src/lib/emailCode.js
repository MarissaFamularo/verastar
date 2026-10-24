// lib/emailCode.js — one-time email code sign-in, shared by onboarding and settings.
//
// A wrong, expired, or already-used code must stay on the code screen with a
// readable error. Reloading here is what blanked the page and dumped people on
// the marketing landing with no session and no message: verify resolved without
// a user, and the screen treated that as success. A hung check gets its own
// timeout message instead of spinning until the page gives up. Sending a new
// code starts a new attempt: the previous check can still sign the user in if
// it succeeds and no session exists yet, but its in-flight state cannot block
// the replacement code.
//
// Every send carries a fresh CAPTCHA token when VITE_TURNSTILE_SITE_KEY is set
// (lib/captcha.js). The token is fetched alongside the Gmail alias lookup and is
// not on the 8s delivery clock: a person may need to answer a check first.

import { useRef, useState } from 'react'
import { awaitWithin } from './deadline.js'
import { CAPTCHA_MESSAGE, getCaptchaToken, isCaptchaError } from './captcha.js'
import { sendCanonicalGmailCode, verifyCanonicalGmailCode } from './gmailCanonical.js'
import { gmailAliasDecision, prepareGmailAlias } from './gmailAlias.js'
import { adoptEmailSession, sendMagicLink, supabase, verifyEmailCode } from './supabase.js'

export const EMAIL_CODE_TIMEOUT_MS = 8000
// A session lookup must not swallow the code-check timeout. Two seconds is long
// enough for a live getSession() and short enough that a stall still fails closed.
export const EMAIL_CODE_SESSION_MS = 2000

export const EMAIL_CODE_MESSAGES = {
  invalid: 'That code is invalid or expired. It may already have been used. Send a new code and try again.',
  timeout: 'Checking the code timed out, so you are not signed in. Try the code again, or send a new code.',
  network: 'We couldn\u2019t reach sign-in just now. Try the code again, or send a new code.',
  rate: 'Too many attempts right now. Wait a minute, then try the same code again.',
}

export function emailCodeFailureKind(err) {
  if (!err) return 'invalid'
  if (err.code === 'timeout' || err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout'
  const raw = `${err.code || ''} ${err.status || ''} ${err.message || err}`.toLowerCase()
  if (/timeout|timed out|abort/.test(raw)) return 'timeout'
  if (Number(err.status) === 429 || /rate.?limit|too many|over_.*_rate|after \d+ seconds/.test(raw)) return 'rate'
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
// The code check itself keeps running after the timeout. A session that is already
// known can still count as success. A session lookup that has not finished does
// not delay the timeout message; if it later finds a user, onLateSession runs.
// A late failure cannot become a success.
export async function verifyEmailCodeForSignIn(email, code, {
  timeoutMs = EMAIL_CODE_TIMEOUT_MS,
  sessionMs = EMAIL_CODE_SESSION_MS,
  verify = verifyEmailCode,
  getSession = defaultGetSession,
  onLateSession,
  onSettled,
} = {}) {
  const pending = Promise.resolve().then(() => verify(email, code))
  let timer
  let timedOut = false
  let honored = false
  let sessionUser = null
  let sessionReady = false
  const sessionPromise = Promise.resolve().then(() => sessionUserFrom(getSession)).then((user) => {
    sessionUser = user || null
    sessionReady = true
    return sessionUser
  }).catch(() => {
    sessionReady = true
    sessionUser = null
    return null
  })
  function honor(user) {
    if (!user || honored) return
    honored = true
    onLateSession?.(user)
  }
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
      const found = user || await sessionUserAfter(sessionPromise, sessionMs)
      if (!found) return { ok: false, kind: 'invalid', message: EMAIL_CODE_MESSAGES.invalid }
      return { ok: true, user: found }
    },
    async (err) => {
      const found = await sessionUserAfter(sessionPromise, sessionMs)
      if (found) return { ok: true, user: found }
      const kind = emailCodeFailureKind(err)
      return { ok: false, kind, message: EMAIL_CODE_MESSAGES[kind] }
    },
  )
  interpreted.then((result) => {
    if (timedOut && result?.ok) honor(result.user)
    onSettled?.(result)
  }).catch(() => { onSettled?.(null) })
  try {
    let outcome = await Promise.race([interpreted, timeout])
    // Only a session that has already settled can change this result. Waiting
    // here is what hid the timeout when getSession() stalled.
    if (!outcome.ok && sessionReady && sessionUser) outcome = { ok: true, user: sessionUser }
    if (outcome.ok) honored = true
    else sessionPromise.then((user) => honor(user))
    return outcome
  } finally {
    clearTimeout(timer)
  }
}

async function sessionUserAfter(sessionPromise, sessionMs) {
  const result = await awaitWithin(sessionPromise, sessionMs)
  if (result.timeout) return null
  return result.value || null
}

export function useEmailCodeSignIn() {
  const attempt = useRef(0)
  // Attempt id of the verifyOtp still in flight, or null. Only that id may
  // block another submit. A resend or reset bumps `attempt`, so a stale flight
  // no longer matches and cannot hold the next code.
  const flight = useRef(null)
  // Destination identity is independent of request/verification counters. Only
  // an explicit account choice or address edit replaces this object. Every
  // asynchronous callback must still belong to it before touching the form.
  const destination = useRef({ kind: 'auto', receipt: null })
  const deliverySequence = useRef(0)
  const sending = useRef(null)
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
  const [sendPending, setSendPending] = useState(false)
  const [aliasNote, setAliasNote] = useState('')

  function chooseDestination(kind = 'auto') {
    destination.current = { kind, receipt: null }
    sending.current = null
    ++attempt.current
    setSendPending(false)
    setResending(false)
    setPending(false)
    setCode('')
    setAliasNote('')
    setSendState('idle')
    setSendError('')
    setVerifyState('idle')
    setVerifyError('')
    setResendNote('')
  }

  function setEmailValue(value) {
    chooseDestination()
    setEmail(value)
  }

  function enter() {
    if (entered.current) return
    entered.current = true
    reloadAfterSignIn()
  }

  function ownsDestination(op) {
    return op.destination === destination.current
  }

  function acceptDelivery(op, receipt) {
    if (!ownsDestination(op)) return
    const previous = op.destination.receipt
    // Completion order is not request order. Never replace a newer successful
    // send, but keep an older success when newer requests have only failed.
    if (previous && previous.sequence > op.sequence) return
    op.destination.receipt = { ...receipt, sequence: op.sequence }
    setAliasNote(receipt.note || '')
    setSendState('sent')
    setSendError('')
    setVerifyError('')
    if (op.resend) {
      setCode('')
      setVerifyState('idle')
      setResendNote('A new code is on its way.')
    }
  }

  function failDelivery(op, message) {
    if (!ownsDestination(op) || sending.current !== op) return
    if (op.destination.receipt) {
      setSendState('sent')
      setSendError('')
      if (op.resend) {
        setVerifyError(message || 'We couldn\u2019t send a new code. Try again in a moment.')
        setVerifyState('error')
      }
    } else {
      setSendState('error')
      setSendError(message || EMAIL_CODE_MESSAGES.network)
    }
  }

  async function deliver(op, decision, captchaToken) {
    const canonical = decision.send === 'canonical'
    const redirectTo = typeof window === 'undefined' ? '' : window.location?.origin || ''
    // The token is only passed when CAPTCHA is configured, so an unconfigured build
    // sends exactly what it sent before.
    const pendingSend = canonical
      ? sendCanonicalGmailCode(captchaToken
        ? { ticket: decision.ticket, redirectTo, captchaToken }
        : { ticket: decision.ticket, redirectTo })
      : captchaToken ? sendMagicLink(op.typed, captchaToken) : sendMagicLink(op.typed)
    const accept = (value) => {
      if (canonical && (!value?.ok || !value.verifyTicket)) {
        failDelivery(op, value?.captcha ? CAPTCHA_MESSAGE : undefined)
        return
      }
      acceptDelivery(op, canonical
        ? { verifyTicket: value.verifyTicket, note: decision.note }
        : { email: op.typed })
    }
    // Attach recovery before racing the timeout. The destination and sequence
    // checks apply equally to ordinary responses and late successes.
    const settled = Promise.resolve(pendingSend).then(accept, (err) => {
      if (isCaptchaError(err)) failDelivery(op, CAPTCHA_MESSAGE)
      else failDelivery(op, canonical ? undefined : err?.message || String(err))
    })
    const result = await awaitWithin(settled, EMAIL_CODE_TIMEOUT_MS)
    if (result.timeout) failDelivery(op)
  }

  async function send(event, options = {}) {
    event?.preventDefault?.()
    const typed = email.trim()
    if (!typed) return
    if (options.force) {
      if (destination.current.kind === 'typed' && sending.current) return
      chooseDestination('typed')
    }
    if (sending.current) return
    const op = {
      destination: destination.current,
      sequence: ++deliverySequence.current,
      typed,
      resend: options.stay === true,
    }
    sending.current = op
    // A resend can release a stalled verification without changing account
    // intent or invalidating successful sends for this same account.
    ++attempt.current
    setPending(false)
    setVerifyState('idle')
    setVerifyError('')
    setResendNote('')
    if (op.resend) setCode('')
    setSendPending(true)
    setResending(op.resend)
    if (!op.destination.receipt) setSendState('sending')
    setSendError('')
    // Settles to { token } or { error }; never rejects, so an abandoned send leaves
    // no unhandled rejection behind.
    const captcha = Promise.resolve()
      .then(() => getCaptchaToken())
      .then((token) => ({ token }), (error) => ({ error }))
    try {
      let decision = { send: 'typed' }
      if (op.destination.kind !== 'typed') {
        let prepared = { match: false }
        try { prepared = await prepareGmailAlias(typed) } catch { /* lookup fails open only before a match */ }
        if (!ownsDestination(op)) return
        decision = gmailAliasDecision(prepared)
        if (decision.send === 'canonical' || decision.send === 'blocked') {
          op.destination.kind = 'canonical'
        }
        if (decision.send === 'blocked' || (decision.send !== 'canonical' && op.destination.kind === 'canonical')) {
          failDelivery(op, 'We couldn\u2019t send a new code. Try again in a moment.')
          return
        }
        // Once a typed-address send is selected, its resends stay at that
        // address too; a later lookup cannot change the account beneath it.
        if (decision.send === 'typed') op.destination.kind = 'typed'
      }
      const proof = await captcha
      if (!ownsDestination(op)) return
      if (proof.error) {
        failDelivery(op, CAPTCHA_MESSAGE)
        return
      }
      await deliver(op, decision, proof.token)
    } catch (err) {
      failDelivery(op, err?.message || EMAIL_CODE_MESSAGES.network)
    } finally {
      // An old request cannot clear the busy state of a new account's request.
      if (sending.current === op) {
        sending.current = null
        setSendPending(false)
        setResending(false)
      }
    }
  }

  function sendSeparate() {
    return send(null, { force: true, stay: true })
  }

  function releaseFlight(id) {
    if (flight.current === id) flight.current = null
  }

  async function verify(event) {
    event?.preventDefault()
    const trimmed = code.trim()
    const selected = destination.current
    if (!selected.receipt) return
    // One verifyOtp for this attempt. Retrying that same code while its request
    // is in flight (including after the 8s timeout) would burn the code and
    // then report it invalid. A newer attempt is a different id, so a stale
    // in-flight check must not block it.
    if (!trimmed || (flight.current !== null && flight.current === attempt.current)) return
    const id = ++attempt.current
    flight.current = id
    setPending(true)
    setVerifyState('verifying')
    setVerifyError('')
    setResendNote('')
    try {
      const ticket = selected.receipt.verifyTicket
      const result = await verifyEmailCodeForSignIn(email.trim(), trimmed, {
        verify: ticket
          ? async () => {
            const session = await verifyCanonicalGmailCode({ verifyTicket: ticket, code: trimmed })
            if (selected !== destination.current) return null
            return adoptEmailSession(session)
          }
          : undefined,
        onLateSession: () => { if (selected === destination.current) enter() },
        onSettled: (settled) => {
          releaseFlight(id)
          if (selected !== destination.current) return
          // Late success from any attempt still signs the user in when this
          // screen has not already taken a session.
          if (settled?.ok) {
            enter()
            return
          }
          if (entered.current || id !== attempt.current) return
          if (settled && !settled.ok) {
            setVerifyError(settled.message)
            setVerifyState('error')
          }
          setPending(false)
        },
      })
      if (selected !== destination.current) return
      if (result.ok) {
        releaseFlight(id)
        enter()
        return
      }
      // A superseded attempt must not rewrite the newer code's screen, and a
      // failure must not undo a session another attempt already opened.
      if (entered.current || id !== attempt.current) return
      setVerifyError(result.message)
      setVerifyState('error')
      // The timeout leaves this attempt in flight so the same code is not
      // submitted twice. Any other result has settled and can be retried.
      if (result.kind !== 'timeout') {
        releaseFlight(id)
        setPending(false)
      }
    } catch (err) {
      releaseFlight(id)
      if (entered.current || id !== attempt.current) return
      setPending(false)
      setVerifyError(err?.message || EMAIL_CODE_MESSAGES.network)
      setVerifyState('error')
    }
  }

  function resend() {
    return send(null, { stay: true })
  }

  function reset() {
    chooseDestination()
  }

  return {
    email, setEmail: setEmailValue, code, setCode,
    sendState, sendError, verifyState, verifyError,
    pending, verifyBusy: pending || verifyState === 'verifying',
    sendPending, sendBusy: sendPending || sendState === 'sending',
    resending, resendNote, aliasNote,
    send, sendSeparate, verify, resend, reset,
  }
}
