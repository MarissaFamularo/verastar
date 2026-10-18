// components/InviteCode.jsx — "Join the beta" for signed-in accounts that are not
// yet sponsored. One field, one button, one sentence back. Hidden once sponsored.
//
// `lead` is the onboarding presentation: full-size, first thing on the connect step,
// because a code is the easy path and the key is the fallback. `preview` (?firstrun=1)
// renders the same box without an account and never calls the server.

import { useEffect, useRef, useState } from 'react'
import { awaitWithin } from '../lib/deadline.js'
import { canRedeem, redeemInviteCode, normalizeInviteCode, INVITE_MESSAGES } from '../lib/inviteCode.js'
import NpiMatch from './NpiMatch.jsx'
import NoNpiContact from './NoNpiContact.jsx'
import { isSponsored } from '../lib/sponsor.js'

export const INVITE_REDEEM_TIMEOUT_MS = 8000
const REDEEM_TIMEOUT = 'Checking the code timed out. Try again.'

export default function InviteCode({ onEnrolled, lead = false, preview = false, onNpiStep, npiOpen, code: codeProp, onCodeChange, npiDraft, onNpiDraft, inputId = 'beta-access-code' }) {
  const [phase, setPhase] = useState('code') // code | npi | confirming
  const [uncontrolledCode, setUncontrolledCode] = useState('')
  const [state, setState] = useState('idle')
  const [note, setNote] = useState('')
  const [ok, setOk] = useState(false)
  const redeemAttempt = useRef(0)
  const onNpiStepRef = useRef(onNpiStep)
  const controlled = codeProp !== undefined
  const activeCode = controlled ? codeProp : uncontrolledCode
  const routed = typeof npiOpen === 'boolean'
  const visibleNote = note
  const visibleOk = ok
  useEffect(() => { onNpiStepRef.current = onNpiStep })

  function updateCode(next) {
    if (controlled) onCodeChange?.(next)
    else setUncontrolledCode(next)
  }

  function showNpi(value, options) {
    setPhase(value ? 'npi' : 'code')
    onNpiStepRef.current?.(value, options)
  }

  if (!preview && (!canRedeem() || isSponsored())) return null

  function settleRedeem(status) {
    if (status === 'npi_required') {
      setOk(false)
      setNote('')
      showNpi(true)
      setState('idle')
      return
    }
    const good = status === 'enrolled' || status === 'already'
    setOk(good)
    setNote(INVITE_MESSAGES[status] || INVITE_MESSAGES.error)
    if (good) {
      updateCode('')
      // The status lets a caller tell a fresh enrollment from an account that was already in.
      onEnrolled?.(status)
      // Sponsorship is already refreshed inside redeem. Unhide the connect
      // heading in the same turn so "You are all set" replaces this step.
      onNpiStepRef.current?.(false)
    }
    setState('idle')
  }

  async function applyCode(afterMatch = false) {
    if (state === 'busy') return
    if (preview) {
      if (!afterMatch) showNpi(true)
      else {
        setOk(true)
        setNote('Preview only — no code or NPI was checked and no access was granted.')
        showNpi(false)
      }
      return
    }
    // Stay off the code form while the post-NPI redeem runs. Dropping back to that
    // form first painted its disabled Continue as "Checking…" before "You are all set".
    if (afterMatch) {
      setPhase('confirming')
      onNpiStep?.(true)
    }
    const attempt = ++redeemAttempt.current
    setState('busy')
    setNote('')
    const pendingRedeem = redeemInviteCode(activeCode)
    try {
      const result = await awaitWithin(pendingRedeem, INVITE_REDEEM_TIMEOUT_MS)
      if (attempt !== redeemAttempt.current) return
      if (result.timeout) {
        setOk(false)
        setNote(REDEEM_TIMEOUT)
        setState('idle')
        pendingRedeem.then((late) => {
          if (attempt === redeemAttempt.current) settleRedeem(late.status)
        }).catch((err) => {
          if (attempt !== redeemAttempt.current) return
          setOk(false)
          setNote(err?.message || INVITE_MESSAGES.error)
          setState('idle')
        })
        return
      }
      // The NPI gate is the next step, not access granted. Do not leave a success note
      // under it, and do not enroll.
      settleRedeem(result.value?.status)
    } catch (err) {
      if (attempt !== redeemAttempt.current) return
      setOk(false)
      setNote(err.message)
      setState('idle')
    }
  }

  // Onboarding passes npiOpen from the route. Settings leaves it unset and keeps
  // this component's own phase. Confirming stays up only while that route still
  // says the NPI step is open; Back/Forward otherwise win. Empty code is a valid path.
  const screen = !routed
      ? phase
      : phase === 'confirming' && npiOpen
        ? 'confirming'
        : npiOpen ? 'npi' : 'code'

  if (screen === 'confirming') {
    return (
      <div>
        <p role={state === 'busy' || !visibleNote || visibleOk ? 'status' : 'alert'} style={{ margin: 0, fontSize: lead ? 15 : 13, lineHeight: 1.5, color: visibleOk ? 'var(--color-verified-soft)' : state === 'busy' || !visibleNote ? 'var(--color-fg)' : 'var(--color-domain-vascular)' }}>
          {state === 'busy' || !visibleNote ? 'Confirming your access…' : visibleNote}
        </p>
        {state !== 'busy' && visibleNote && !visibleOk && (
          <button type="button" onClick={() => { setNote(''); showNpi(false) }} style={{ marginTop: 16, border: 0, background: 'transparent', padding: 0, color: 'var(--color-fg-dim)', fontFamily: 'inherit', fontSize: 14 }}>
            Back
          </button>
        )}
      </div>
    )
  }

  if (screen === 'npi') return <NpiMatch requirePhysician={!activeCode.trim()} preview={preview} draft={npiDraft} onDraft={onNpiDraft}
    onBack={() => { showNpi(false); setNote('') }}
    onContinue={() => { void applyCode(true) }} />

  const big = lead
  return (
    <form onSubmit={(event) => { event.preventDefault(); void applyCode() }} style={big
      ? { borderRadius: 12, border: '1px solid rgba(239,143,91,.28)', background: 'var(--surface-1)', padding: '16px 18px' }
      : { marginTop: 12, borderRadius: 10, border: '1px solid rgba(255,255,255,.08)', background: 'var(--surface-1)', padding: '10px 13px' }}>
      <label htmlFor={inputId} style={{ display: 'block', margin: 0, fontSize: big ? 15 : 12.5, fontWeight: 600, color: big ? 'var(--color-fg)' : 'var(--color-fg-soft)' }}>Join the beta</label>
      <p id={`${inputId}-hint`} style={{ margin: big ? '4px 0 12px' : '3px 0 8px', fontSize: big ? 13.5 : 11.5, color: big ? 'var(--color-fg-dim)' : 'var(--color-fg-faint)', lineHeight: 1.5 }}>
        {big
          ? 'Invitation code optional. Continue with your verified email and a matching individual physician NPI/name. No personal API key is needed.'
          : 'Use an invitation code, or continue without one using your verified email and a matching individual physician NPI/name.'}
      </p>
      <div className="flex" style={{ gap: big ? 10 : 8 }}>
        <input
          id={inputId}
          type="text"
          value={activeCode}
          // Show the code the way it was issued, as it is typed, so what they see is what is sent.
          onChange={(e) => updateCode(normalizeInviteCode(e.target.value))}
          placeholder="Beta access code (optional)"
          autoComplete="off"
          autoCapitalize="characters"
          disabled={state === 'busy'}
          aria-describedby={`${inputId}-hint`}
          className="min-w-0 flex-1"
          style={{ padding: big ? '12px 15px' : '8px 10px', borderRadius: big ? 11 : 8, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: big ? 15 : 12.5, fontFamily: 'inherit', outline: 'none' }}
        />
        <button type="submit" disabled={state === 'busy'} aria-describedby={`${inputId}-hint`} className="cursor-pointer" style={{ padding: big ? '12px 20px' : '6px 10px', border: 0, borderRadius: big ? 11 : 8, background: 'var(--color-accent)', color: '#1c1206', fontSize: big ? 15 : 11.5, fontWeight: 600, fontFamily: 'inherit', opacity: state === 'busy' ? 0.5 : 1 }}>
          {state === 'busy' ? 'Checking…' : 'Continue'}
        </button>
      </div>
      {visibleNote && <p role={visibleOk ? 'status' : 'alert'} style={{ margin: '8px 0 0', fontSize: big ? 13 : 12, color: visibleOk ? 'var(--color-verified-soft)' : 'var(--color-domain-vascular)' }}>{visibleNote}</p>}
      <NoNpiContact small={!big} />
    </form>
  )
}

// The sentence a feature already shows when model access is closed, plus the
// invite field. InviteCode hides itself until someone is signed in and unsponsored.
export function BetaAccessGate({ inputId, onEnrolled, children }) {
  return (
    <>
      {children}
      <InviteCode inputId={inputId} onEnrolled={onEnrolled} />
    </>
  )
}
