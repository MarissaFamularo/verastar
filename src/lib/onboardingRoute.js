// lib/onboardingRoute.js — hash steps for the first-run flow.
//
// Welcome, sign-in, connect, interview, and review used to share one URL, so the
// browser Back button left onboarding entirely. Each step is now a hash on the
// same path (`#signin`, `#connect`, …). Welcome stays the bare path so the
// landing URL does not change. Supabase magic-link hashes are left alone.
// The NPI form is a history entry on `#connect` (`state.substep === 'npi'`).
// The invitation code and any NPI fields typed so far ride along in that same
// history entry, so Back, Forward, and a reload in this tab restore them.
// They are not written to storage.

import { useEffect, useRef, useState } from 'react'

export const ONBOARD_STEPS = ['welcome', 'signin', 'connect', 'interview', 'review']

const AUTH_HASH = /(?:^#|&)(?:access_token|refresh_token|provider_token|token_type|error|error_code|error_description)=/

export function isAuthCallbackHash(hash) {
  return AUTH_HASH.test(String(hash || ''))
}

// Known step, 'welcome' for an empty hash, or null when the hash belongs to
// auth or to something this flow does not own.
export function onboardStepFromHash(hash) {
  const value = String(hash || '')
  if (isAuthCallbackHash(value)) return null
  const raw = value.replace(/^#/, '').split('&')[0]
  if (!raw || raw === 'welcome') return 'welcome'
  return ONBOARD_STEPS.includes(raw) ? raw : null
}

export function onboardUrl(loc, step) {
  const path = loc?.pathname || '/'
  const search = loc?.search || ''
  if (!step || step === 'welcome') return `${path}${search}`
  return `${path}${search}#${step}`
}

function pageLocation() {
  const loc = typeof window !== 'undefined' ? window.location : null
  if (!loc) return { pathname: '/', search: '', hash: '' }
  return loc
}

function pageHistory() {
  const history = typeof window !== 'undefined' ? window.history : null
  if (!history || typeof history.pushState !== 'function') return null
  return history
}

function npiDraftFrom(value) {
  if (!value || typeof value !== 'object') return null
  const draft = {
    firstName: String(value.firstName || ''),
    lastName: String(value.lastName || ''),
    npi: String(value.npi || ''),
  }
  return draft.firstName || draft.lastName || draft.npi ? draft : null
}

function connectDataFrom(step, state) {
  if (step !== 'connect') return { inviteCode: '', npiDraft: null, codeNotice: '' }
  return {
    inviteCode: typeof state?.inviteCode === 'string' ? state.inviteCode : '',
    npiDraft: npiDraftFrom(state?.npiDraft),
    codeNotice: state?.codeNotice === 'required' ? 'required' : '',
  }
}

function routeFromLocation() {
  const hash = pageLocation().hash
  const step = onboardStepFromHash(hash) || 'welcome'
  const historyState = pageHistory()?.state
  const substep = step === 'connect' && historyState?.substep === 'npi' ? 'npi' : null
  return { step, substep, ...connectDataFrom(step, historyState) }
}

export function useOnboardStep() {
  const initial = routeFromLocation()
  const [step, setStepState] = useState(initial.step)
  const [substep, setSubstep] = useState(initial.substep)
  const [inviteCode, setInviteCodeState] = useState(initial.inviteCode)
  const [npiDraft, setNpiDraftState] = useState(initial.npiDraft)
  const [codeNotice, setCodeNoticeState] = useState(initial.codeNotice)
  const stepRef = useRef(step)
  const substepRef = useRef(substep)
  const inviteCodeRef = useRef(inviteCode)
  const npiDraftRef = useRef(npiDraft)
  const codeNoticeRef = useRef(codeNotice)

  function applyRoute(next) {
    stepRef.current = next.step
    substepRef.current = next.substep || null
    inviteCodeRef.current = next.inviteCode || ''
    npiDraftRef.current = next.npiDraft || null
    codeNoticeRef.current = next.codeNotice || ''
    setStepState(next.step)
    setSubstep(next.substep || null)
    setInviteCodeState(next.inviteCode || '')
    setNpiDraftState(next.npiDraft || null)
    setCodeNoticeState(next.codeNotice || '')
  }

  function connectState(substepValue = substepRef.current) {
    const state = { onboard: 'connect', inviteCode: inviteCodeRef.current }
    if (substepValue) state.substep = substepValue
    if (npiDraftRef.current) state.npiDraft = npiDraftRef.current
    if (codeNoticeRef.current) state.codeNotice = codeNoticeRef.current
    return state
  }

  useEffect(() => {
    const history = pageHistory()
    const hash = pageLocation().hash
    const fromHash = onboardStepFromHash(hash)
    if (history && !isAuthCallbackHash(hash)) {
      if (fromHash && fromHash !== 'welcome' && history.state?.onboard !== fromHash) {
        // Put welcome behind a deep link so Back stays inside onboarding.
        history.replaceState({ onboard: 'welcome' }, '', onboardUrl(pageLocation(), 'welcome'))
        const seeded = fromHash === 'connect'
          ? connectState(substepRef.current)
          : { onboard: fromHash }
        history.pushState(seeded, '', onboardUrl(pageLocation(), fromHash))
      } else if (fromHash && !history.state?.onboard) {
        const state = fromHash === 'connect' ? connectState(substepRef.current) : { onboard: stepRef.current }
        history.replaceState(state, '', onboardUrl(pageLocation(), stepRef.current))
      }
    }
    function onPop() {
      const next = onboardStepFromHash(pageLocation().hash)
      if (!next) return
      const historyState = pageHistory()?.state
      applyRoute({
        step: next,
        substep: next === 'connect' && historyState?.substep === 'npi' ? 'npi' : null,
        ...connectDataFrom(next, historyState),
      })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function goStep(next, { replace = false } = {}) {
    if (!next || (next === stepRef.current && !substepRef.current && !replace)) return
    const history = pageHistory()
    if (history) {
      const url = onboardUrl(pageLocation(), next)
      const state = { onboard: next }
      if (replace) history.replaceState(state, '', url)
      else history.pushState(state, '', url)
    }
    applyRoute({ step: next, substep: null, inviteCode: '', npiDraft: null, codeNotice: '' })
  }

  function rememberConnect(patch) {
    if (stepRef.current !== 'connect') return
    if (Object.prototype.hasOwnProperty.call(patch, 'inviteCode')) {
      inviteCodeRef.current = String(patch.inviteCode || '')
      if (inviteCodeRef.current.trim()) codeNoticeRef.current = ''
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'npiDraft')) npiDraftRef.current = npiDraftFrom(patch.npiDraft)
    setInviteCodeState(inviteCodeRef.current)
    setNpiDraftState(npiDraftRef.current)
    setCodeNoticeState(codeNoticeRef.current)
    const history = pageHistory()
    if (history) history.replaceState(connectState(), '', onboardUrl(pageLocation(), 'connect'))
  }

  // `npi` pushes a `#connect` entry that carries the code and NPI fields.
  // Closing it uses Back so Forward returns to that same entry. `discard`
  // drops the substep in place when the entry can no longer be completed.
  function goSubstep(next, options = {}) {
    if (stepRef.current !== 'connect') return
    const want = next === 'npi' ? 'npi' : null
    const discard = Boolean(options.discard)
    if ((substepRef.current || null) === want && !discard) return
    const history = pageHistory()
    const url = onboardUrl(pageLocation(), 'connect')
    if (!want && !discard && history?.state?.substep === 'npi' && typeof history.back === 'function') {
      substepRef.current = null
      history.back()
      return
    }
    if (discard && !inviteCodeRef.current.trim()) codeNoticeRef.current = 'required'
    const state = connectState(want)
    if (history) {
      if (want) history.pushState(state, '', url)
      else history.replaceState(state, '', url)
    }
    applyRoute({
      step: 'connect',
      substep: want,
      inviteCode: inviteCodeRef.current,
      npiDraft: npiDraftRef.current,
      codeNotice: codeNoticeRef.current,
    })
  }

  function backStep() {
    const history = pageHistory()
    if (history?.state?.onboard && history.state.onboard !== 'welcome' && typeof history.back === 'function') {
      history.back()
      return
    }
    goStep('welcome')
  }

  return [step, goStep, backStep, substep, goSubstep, inviteCode, rememberConnect, npiDraft, codeNotice]
}
