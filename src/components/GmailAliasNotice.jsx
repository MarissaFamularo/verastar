export function GmailAliasNotice({ message, onContinue, busy }) {
  if (!message) return null
  return (
    <div role="status" style={{ marginTop: 12, padding: '10px 13px', borderRadius: 10, background: 'rgba(230,184,119,.12)', color: 'var(--color-abstract)', fontSize: 13, lineHeight: 1.5 }}>
      <p style={{ margin: 0 }}>{message}</p>
      <button type="button" onClick={onContinue} disabled={busy} className="cursor-pointer" style={{ marginTop: 8, border: 0, background: 'transparent', padding: 0, color: 'var(--color-accent)', fontSize: 13, fontFamily: 'inherit' }}>
        {busy ? 'Sending…' : 'Send a code to this address anyway'}
      </button>
    </div>
  )
}
