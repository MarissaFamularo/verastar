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

import { useRef, useState } from 'react'
import { awaitWithin } from './deadline.js'
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
  const sendFlight = useRef(null)
  // Holds the Gmail alias lookup. sendFlight starts only after that lookup, so
  // a second click in the gap would otherwise send two codes.
  const aliasFlight = useRef(false)
  const emailGen = useRef(0)
  const entered = useRef(false)
  // Set when a different Gmail spelling of an existing account is confirmed.
  // A later limited or failed lookup must not send to the typed address.
  const aliasDestination = useRef(null)
  // Verification ticket for that existing account. The typed address is not used.
  const canonical = useRef(null)
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

  function clearCanonical() {
    canonical.current = null
    aliasDestination.current = null
    setAliasNote('')
  }

  function stillCurrent(id, gen) {
    return id === attempt.current && gen === emailGen.current
  }

  function setEmailValue(value) {
    emailGen.current += 1
    clearCanonical()
    setEmail(value)
  }

  function enter() {
    if (entered.current) return
    entered.current = true
    reloadAfterSignIn()
  }

  async function finishSend(pending, id, onSuccess, onTimeout) {
    try {
      const result = await awaitWithin(pending, EMAIL_CODE_TIMEOUT_MS)
      if (id !== attempt.current) return
      if (result.timeout) {
        onTimeout()
        pending.then(() => {
          if (id === attempt.current) onSuccess()
        }).catch(() => {})
        return
      }
      onSuccess()
    } catch (err) {
      if (id !== attempt.current) return
      onTimeout(err?.message || String(err))
    } finally {
      if (sendFlight.current === pending) {
        sendFlight.current = null
        setSendPending(false)
      }
    }
  }

  function redirectOrigin() {
    if (typeof window === 'undefined') return ''
    return window.location?.origin || ''
  }

  async function deliverTyped(typed, { stay = false } = {}) {
    const id = ++attempt.current
    const pending = sendMagicLink(typed)
    sendFlight.current = pending
    aliasFlight.current = false
    setSendPending(true)
    if (stay) setResending(true)
    else setSendState('sending')
    setSendError('')
    await finishSend(pending, id, () => {
      clearCanonical()
      setSendError('')
      setSendState('sent')
      if (stay) {
        setCode('')
        setVerifyError('')
        setVerifyState('idle')
        setResendNote('A new code is on its way.')
      }
    }, (message) => {
      if (stay) {
        setSendState('sent')
        setVerifyError(message || 'We couldn\u2019t send a new code. Try again in a moment.')
        setVerifyState('error')
      } else {
        setSendError(message || EMAIL_CODE_MESSAGES.network)
        setSendState('error')
      }
    })
    if (stay) setResending(false)
  }

  function acceptCanonical(id, gen, decision, value, { resend = false, typed } = {}) {
    // An older attempt must not replace a ticket or a receipt a newer one already showed.
    if (!stillCurrent(id, gen)) return
    if (!value?.ok || !value.verifyTicket) return
    canonical.current = { verifyTicket: value.verifyTicket }
    aliasDestination.current = { typed: typed || aliasDestination.current?.typed || '', note: decision.note }
    setAliasNote(decision.note)
    setSendError('')
    setSendState('sent')
    if (resend) {
      setCode('')
      setVerifyError('')
      setVerifyState('idle')
      setResendNote('A new code is on its way.')
    }
  }

  function failCanonical(id, gen, { resend = false } = {}) {
    if (!stillCurrent(id, gen)) return
    if (resend) {
      setVerifyError('We couldn\u2019t send a new code. Try again in a moment.')
      setVerifyState('error')
      return
    }
    setSendError(EMAIL_CODE_MESSAGES.network)
    setSendState('error')
  }

  // The send keeps running after the timeout. A late ticket is kept only while
  // this attempt is still the current one.
  async function settleCanonical(decision, id, gen, { resend = false, typed } = {}) {
    const pending = sendCanonicalGmailCode({ ticket: decision.ticket, redirectTo: redirectOrigin() })
    let raced
    try {
      raced = await awaitWithin(pending, EMAIL_CODE_TIMEOUT_MS)
    } catch {
      failCanonical(id, gen, { resend })
      return
    }
    if (!stillCurrent(id, gen)) return
    if (raced.timeout) {
      failCanonical(id, gen, { resend })
      pending.then((value) => {
        acceptCanonical(id, gen, decision, value, { resend, typed })
      }).catch(() => {})
      return
    }
    if (!raced.value?.ok) {
      failCanonical(id, gen, { resend })
      return
    }
    acceptCanonical(id, gen, decision, raced.value, { resend, typed })
  }

  async function deliverCanonical(decision, gen, typed) {
    const id = ++attempt.current
    await settleCanonical(decision, id, gen, { typed })
  }

  async function send(event, options) {
    event?.preventDefault?.()
    const force = options?.force === true
    const stay = options?.stay === true
    const typed = email.trim()
    if (!typed || sendFlight.current || aliasFlight.current) return
    const gen = emailGen.current
    if (!force) {
      aliasFlight.current = true
      setSendPending(true)
      setSendState('sending')
      setSendError('')
      let prepared = { match: false }
      try {
        prepared = await prepareGmailAlias(typed)
      } catch {
        prepared = { match: false }
      }
      if (gen !== emailGen.current) {
        aliasFlight.current = false
        setSendPending(false)
        setSendState('idle')
        return
      }
      const decision = gmailAliasDecision(prepared)
      if (decision.send === 'canonical') {
        aliasDestination.current = { typed, note: decision.note }
        try {
          await deliverCanonical(decision, gen, typed)
        } finally {
          aliasFlight.current = false
          setSendPending(false)
        }
        return
      }
      if (decision.send === 'blocked') {
        if (aliasDestination.current?.typed !== typed) aliasDestination.current = { typed, note: '' }
        aliasFlight.current = false
        setSendPending(false)
        setSendState('error')
        setSendError(EMAIL_CODE_MESSAGES.network)
        return
      }
      // A confirmed alias stays on that account. A limited or failed lookup
      // must not open a second account at the spelling that was typed.
      if (aliasDestination.current?.typed === typed) {
        aliasFlight.current = false
        setSendPending(false)
        setSendState('error')
        setSendError('We couldn\u2019t send a new code. Try again in a moment.')
        return
      }
      aliasFlight.current = false
    }
    await deliverTyped(typed, { stay })
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
      const ticket = canonical.current?.verifyTicket
      const result = await verifyEmailCodeForSignIn(email.trim(), trimmed, {
        verify: ticket
          ? async () => adoptEmailSession(await verifyCanonicalGmailCode({ verifyTicket: ticket, code: trimmed }))
          : undefined,
        onLateSession: () => enter(),
        onSettled: (settled) => {
          releaseFlight(id)
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

  async function resend() {
    if (!email.trim() || resending || sendFlight.current || aliasFlight.current) return
    // The new code supersedes the previous check. Bumping the attempt id is
    // what unblocks submit: the old flight no longer matches. Drop the busy
    // flag now so the replacement can be typed and sent while that request
    // is still outstanding. A late success still reaches enter().
    const id = ++attempt.current
    const gen = emailGen.current
    setPending(false)
    setResending(true)
    setVerifyState('idle')
    setVerifyError('')
    setResendNote('')
    setCode('')
    if (canonical.current || aliasDestination.current) {
      const typed = email.trim()
      try {
        const prepared = await prepareGmailAlias(typed)
        if (!stillCurrent(id, gen)) return
        const decision = gmailAliasDecision(prepared)
        if (decision.send !== 'canonical') {
          setVerifyError('We couldn\u2019t send a new code. Try again in a moment.')
          setVerifyState('error')
          return
        }
        aliasDestination.current = { typed, note: decision.note }
        await settleCanonical(decision, id, gen, { resend: true, typed })
      } catch {
        if (!stillCurrent(id, gen)) return
        setVerifyError('We couldn\u2019t send a new code. Try again in a moment.')
        setVerifyState('error')
      } finally {
        setResending(false)
      }
      return
    }
    const pending = sendMagicLink(email.trim())
    sendFlight.current = pending
    setSendPending(true)
    try {
      await finishSend(pending, id, () => {
        setSendState('sent')
        setVerifyError('')
        setVerifyState('idle')
        setResendNote('A new code is on its way.')
      }, (message) => {
        setSendState('sent')
        setVerifyError(message || 'We couldn\u2019t send a new code. Try again in a moment.')
        setVerifyState('error')
      })
    } finally {
      setResending(false)
    }
  }

  function reset() {
    emailGen.current += 1
    ++attempt.current
    setPending(false)
    setSendState('idle')
    setSendError('')
    setVerifyState('idle')
    setVerifyError('')
    setResendNote('')
    setResending(false)
    setCode('')
    clearCanonical()
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
