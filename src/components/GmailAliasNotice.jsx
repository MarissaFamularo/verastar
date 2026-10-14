const sentBox = {
  padding: '12px 15px',
  borderRadius: 11,
  background: 'rgba(127,191,154,.1)',
  color: 'var(--color-verified-soft)',
  fontSize: 14,
  lineHeight: 1.55,
}

const separateLink = {
  marginTop: 8,
  border: 0,
  background: 'transparent',
  padding: 0,
  color: 'var(--color-accent)',
  fontSize: 12.5,
  fontFamily: 'inherit',
}

// The green receipt after a code is sent. A Gmail alias names the masked
// account the code went to, with a small link that starts a separate account
// at the spelling that was typed.
export function EmailCodeStatus({ email, aliasNote, onSeparate, busy, compact = false }) {
  const style = compact
    ? { ...sentBox, padding: '10px 13px', borderRadius: 10, fontSize: 13 }
    : sentBox
  if (aliasNote) {
    return (
      <div role="status" style={style}>
        <p style={{ margin: 0, fontWeight: 600 }}>{aliasNote}</p>
        <p style={{ margin: '6px 0 0' }}>Enter the 6-digit code from that email.</p>
        <button type="button" onClick={onSeparate} disabled={busy} className="cursor-pointer" style={separateLink}>
          {busy ? 'Sending…' : 'Create a separate account with this spelling instead'}
        </button>
      </div>
    )
  }
  return (
    <div role="status" style={style}>
      <span style={{ fontWeight: 600 }}>Code sent to {email}.</span> Enter the 6-digit code from that email.
    </div>
  )
}
