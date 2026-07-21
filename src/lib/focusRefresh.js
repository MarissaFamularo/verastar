// lib/focusRefresh.js — data-level refresh when the window regains focus.
//
// Signed in, another device may have written to the account while this tab sat in
// the background — refetching on focus is the whole cross-device "sync" story (no
// realtime in v1, by design). The hazard this hook is built around: surfaces must
// NOT remount to pick up fresh data — a remount mid-digest-run throws away paid
// extraction work. So callers pass a setState-style loader and keep their mounted
// component; nothing here touches keys or navigation.
//
// Callers gate their own handler (e.g. skip while generating, or signed-out where
// there is nothing remote to refetch). The handler ref is kept current so the
// listener never sees a stale closure.

import { useEffect, useRef } from 'react'

export function useWindowFocusRefresh(handler) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const onFocus = () => ref.current?.()
    const onVisible = () => {
      if (document.visibilityState === 'visible') ref.current?.()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
}
