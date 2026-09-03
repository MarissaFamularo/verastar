// lib/useRetractionAlerts.js — the mounted view of lib/retractionWatch.js: the current list of
// unacknowledged retractions, kept live while this component is on screen. Also hands back
// each newly patched record so a surface holding its own `papers` state can patch in place.
//
// Subscribe-only, deliberately: the list arrives from whichever check or acknowledgement
// runs next (boot, a digest scan, the Library opening). Reading the store here would race
// App's boot, which picks the storage backend AFTER first render — a read before that lands
// on the wrong backend for a signed-in account.

import { useEffect, useRef, useState } from 'react'
import { subscribeRetractionAlerts } from './retractionWatch.js'

export function useRetractionAlerts({ onPatched } = {}) {
  const [alerts, setAlerts] = useState([])
  const patchedRef = useRef(onPatched)
  patchedRef.current = onPatched
  useEffect(
    () =>
      subscribeRetractionAlerts(({ pending, patched }) => {
        setAlerts(pending)
        if (patched?.length) patchedRef.current?.(patched)
      }),
    [],
  )
  return alerts
}
