// lib/useMobile.js — "are we on the phone layout?" as a live hook. One source of
// truth: the same ≤760px breakpoint where index.css turns the rail into a tab bar,
// so JS-side layout decisions (collapse, view gating) flip exactly with the CSS.

import { useSyncExternalStore } from 'react'

const QUERY = '(max-width: 760px)'

function subscribe(cb) {
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

export function isMobileNow() {
  return window.matchMedia(QUERY).matches
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, isMobileNow)
}
