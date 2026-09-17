// components/InviteCode.jsx — "Have an access code?" for signed-in accounts that are not
// yet sponsored. One field, one button, one sentence back. Hidden once sponsored.

import { useState } from 'react'
import { canRedeem, redeemInviteCode, INVITE_MESSAGES } from '../lib/inviteCode.js'
import { isSponsored } from '../lib/sponsor.js'

export default function InviteCode({ onEnrolled }) {
  const [code, setCode] = useState('')
  const [state, setState] = useState('idle')
  const [note, setNote] = useState('')
  const [ok, setOk] = useState(false)
  if (!canRedeem() || isSponsored()) return null

  async function submit(e) {
    e.preventDefault()
    if (!code.trim() || state === 'busy') return
    setState('busy')
    setNote('')
    try {
      const { status } = await redeemInviteCode(code)
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

  return (
    <form onSubmit={submit} style={{ marginTop: 12, borderRadius: 10, border: '1px solid rgba(255,255,255,.08)', background: 'var(--surface-1)', padding: '10px 13px' }}>
      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--color-fg-soft)' }}>Have an access code?</p>
      <p style={{ margin: '3px 0 8px', fontSize: 11.5, color: 'var(--color-fg-faint)', lineHeight: 1.5 }}>
        Study participants get a code with their welcome email. Enter it here and Verastar runs without a key on this account.
      </p>
      <div className="flex" style={{ gap: 8 }}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Access code"
          autoComplete="off"
          disabled={state === 'busy'}
          className="min-w-0 flex-1"
          style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: 12.5, fontFamily: 'inherit', outline: 'none' }}
        />
        <button type="submit" disabled={!code.trim() || state === 'busy'} style={{ padding: '6px 10px', border: 0, borderRadius: 8, background: 'var(--color-accent)', color: '#1c1206', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', opacity: !code.trim() || state === 'busy' ? 0.5 : 1 }}>
          {state === 'busy' ? 'Checking…' : 'Apply'}
        </button>
      </div>
      {note && <p style={{ margin: '8px 0 0', fontSize: 12, color: ok ? 'var(--color-verified-soft)' : 'var(--color-domain-vascular)' }}>{note}</p>}
    </form>
  )
}
