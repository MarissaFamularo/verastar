// components/InviteCode.jsx — "Have a beta access code?" for signed-in accounts that are not
// yet sponsored. One field, one button, one sentence back. Hidden once sponsored.
//
// `lead` is the onboarding presentation: full-size, first thing on the connect step,
// because a code is the easy path and the key is the fallback. `preview` (?firstrun=1)
// renders the same box without an account and never calls the server.

import { useState } from 'react'
import { canRedeem, redeemInviteCode, normalizeInviteCode, INVITE_MESSAGES } from '../lib/inviteCode.js'
import NpiMatch from './NpiMatch.jsx'
import { isSponsored } from '../lib/sponsor.js'

export default function InviteCode({ onEnrolled, lead = false, preview = false, onNpiStep }) {
  const [needsNpi, setNeedsNpi] = useState(false)
  const [code, setCode] = useState('')
  const [state, setState] = useState('idle')
  const [note, setNote] = useState('')
  const [ok, setOk] = useState(false)
  if (!preview && (!canRedeem() || isSponsored())) return null

  function showNpi(value) { setNeedsNpi(value); onNpiStep?.(value) }

  async function applyCode(afterMatch = false) {
    if (!code.trim() || state === 'busy') return
    if (preview) {
      if (!afterMatch) showNpi(true)
      else { setOk(true); setNote('Preview only — no code or NPI was checked and no access was granted.') }
      return
    }
    setState('busy')
    setNote('')
    try {
      const { status } = await redeemInviteCode(code)
      if (status === 'npi_required') showNpi(true)
      const good = status === 'enrolled' || status === 'already'
      setOk(good)
      setNote(INVITE_MESSAGES[status] || INVITE_MESSAGES.error)
      if (good) { setCode(''); onEnrolled?.() }
    } catch (err) {
      setOk(false)
      setNote(err.message)
    }
    setState('idle')
  }

  if (needsNpi) return <NpiMatch preview={preview}
    onBack={() => { showNpi(false); setNote('') }}
    onContinue={() => { showNpi(false); void applyCode(true) }} />

  const big = lead
  return (
    <form onSubmit={(event) => { event.preventDefault(); void applyCode() }} style={big
      ? { borderRadius: 12, border: '1px solid rgba(239,143,91,.28)', background: 'var(--surface-1)', padding: '16px 18px' }
      : { marginTop: 12, borderRadius: 10, border: '1px solid rgba(255,255,255,.08)', background: 'var(--surface-1)', padding: '10px 13px' }}>
      <p style={{ margin: 0, fontSize: big ? 15 : 12.5, fontWeight: 600, color: big ? 'var(--color-fg)' : 'var(--color-fg-soft)' }}>Have a beta access code?</p>
      <p style={{ margin: big ? '4px 0 12px' : '3px 0 8px', fontSize: big ? 13.5 : 11.5, color: big ? 'var(--color-fg-dim)' : 'var(--color-fg-faint)', lineHeight: 1.5 }}>
        A beta access code is an invitation from the Verastar team for sponsored access. Enter the code you received, then match your name and NPI. No personal API key is needed.
      </p>
      <div className="flex" style={{ gap: big ? 10 : 8 }}>
        <input
          type="text"
          value={code}
          // Show the code the way it was issued, as it is typed, so what they see is what is sent.
          onChange={(e) => setCode(normalizeInviteCode(e.target.value))}
          placeholder="Beta access code"
          aria-label="Access code"
          autoComplete="off"
          autoCapitalize="characters"
          disabled={state === 'busy'}
          className="min-w-0 flex-1"
          style={{ padding: big ? '12px 15px' : '8px 10px', borderRadius: big ? 11 : 8, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: big ? 15 : 12.5, fontFamily: 'inherit', outline: 'none' }}
        />
        <button type="submit" disabled={!code.trim() || state === 'busy'} className="cursor-pointer" style={{ padding: big ? '12px 20px' : '6px 10px', border: 0, borderRadius: big ? 11 : 8, background: 'var(--color-accent)', color: '#1c1206', fontSize: big ? 15 : 11.5, fontWeight: 600, fontFamily: 'inherit', opacity: !code.trim() || state === 'busy' ? 0.5 : 1 }}>
          {state === 'busy' ? 'Checking…' : 'Continue'}
        </button>
      </div>
      {note && <p style={{ margin: '8px 0 0', fontSize: big ? 13 : 12, color: ok ? 'var(--color-verified-soft)' : 'var(--color-domain-vascular)' }}>{note}</p>}
    </form>
  )
}
