// lib/onboardingRoute.js — hash steps for the first-run flow.
//
// Welcome, sign-in, connect, interview, and review used to share one URL, so the
// browser Back button left onboarding entirely. Each step is now a hash on the
// same path (`#signin`, `#connect`, …). Welcome stays the bare path so the
// landing URL does not change. Supabase magic-link hashes are left alone.

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

export function useOnboardStep() {
  const [step, setStepState] = useState(() => onboardStepFromHash(pageLocation().hash) || 'welcome')
  const stepRef = useRef(step)

  useEffect(() => {
    const history = pageHistory()
    const hash = pageLocation().hash
    const fromHash = onboardStepFromHash(hash)
    if (history && !isAuthCallbackHash(hash)) {
      if (fromHash && fromHash !== 'welcome' && history.state?.onboard !== fromHash) {
        // Put welcome behind a deep link so Back stays inside onboarding.
        history.replaceState({ onboard: 'welcome' }, '', onboardUrl(pageLocation(), 'welcome'))
        history.pushState({ onboard: fromHash }, '', onboardUrl(pageLocation(), fromHash))
      } else if (fromHash && !history.state?.onboard) {
        history.replaceState({ onboard: stepRef.current }, '', onboardUrl(pageLocation(), stepRef.current))
      }
    }
    function onPop() {
      const next = onboardStepFromHash(pageLocation().hash)
      if (!next) return
      stepRef.current = next
      setStepState(next)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function goStep(next, { replace = false } = {}) {
    if (!next || (next === stepRef.current && !replace)) return
    const history = pageHistory()
    if (history) {
      const url = onboardUrl(pageLocation(), next)
      const state = { onboard: next }
      if (replace) history.replaceState(state, '', url)
      else history.pushState(state, '', url)
    }
    stepRef.current = next
    setStepState(next)
  }

  function backStep() {
    const history = pageHistory()
    if (history?.state?.onboard && history.state.onboard !== 'welcome' && typeof history.back === 'function') {
      history.back()
      return
    }
    goStep('welcome')
  }

  return [step, goStep, backStep]
}
