import { useRef, useState } from 'react'
import { awaitWithin } from '../lib/deadline.js'
import { currentNpiMatch, matchNpi } from '../lib/npi.js'
import NoNpiContact from './NoNpiContact.jsx'

const NPI_MATCH_TIMEOUT_MS = 8000

export default function NpiMatch({ onContinue, onBack, preview = false, draft, onDraft, requirePhysician = false }) {
  const [match, setMatch] = useState(() => preview ? null : (requirePhysician && !currentNpiMatch()?.physician ? null : currentNpiMatch()))
  const [fields, setFields] = useState(() => ({
    firstName: draft?.firstName || match?.firstName || '',
    lastName: draft?.lastName || match?.lastName || '',
    npi: draft?.npi || match?.npi || '',
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  function change(key, value) {
    revision.current += 1
    setFields((previous) => {
      const next = { ...previous, [key]: value }
      onDraft?.(next)
      return next
    })
    setMatch(null)
    setError('')
    setBusy(false)
  }
  async function submit(event) {
    event.preventDefault()
    if (busy || preview) return
    const attempt = ++revision.current
    setBusy(true)
    setMatch(null)
    setError('')
    const pending = matchNpi({ ...fields, npi: fields.npi.trim() })
    try {
      const result = await awaitWithin(pending, NPI_MATCH_TIMEOUT_MS)
      if (revision.current !== attempt) return
      if (result.timeout) {
        setError('Checking the NPI timed out. Try again.')
        pending.then((receipt) => {
          if (revision.current !== attempt || !receipt || (requirePhysician && !receipt.physician)) return
          setError('')
          setMatch(receipt)
        }).catch(() => {})
        return
      }
      if (requirePhysician && !result.value?.physician) {
        setError('This NPI does not list a physician taxonomy. Check your NPI or use your invitation code.'); return
      }
      setMatch(result.value)
    } catch (err) {
      if (revision.current === attempt) setError(err.message)
    } finally {
      if (revision.current === attempt) setBusy(false)
    }
  }
  const inputStyle = { width: '100%', marginTop: 6, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: 16 }
  const buttonStyle = { padding: '12px 20px', borderRadius: 10, border: 0, background: 'var(--color-accent)', color: '#1c1206', fontWeight: 600 }
  return <div style={{ maxWidth: 480 }}>
    <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 30, margin: 0 }}>Your NPI</h2>
    <p style={{ color: 'var(--color-fg-dim)', lineHeight: 1.6 }}>Enter your name as it appears in the NPI Registry to join the beta.</p>
    <form onSubmit={submit}>
      {[
        ['firstName', 'First name', 'given-name'], ['lastName', 'Last name', 'family-name'], ['npi', 'NPI number', 'off'],
      ].map(([key, label, autoComplete]) => <label key={key} htmlFor={`npi-${key}`} style={{ display: 'block', marginTop: 16, fontSize: 14 }}>
        {label}
        <input id={`npi-${key}`} type="text" name={key} value={fields[key]} onChange={(e) => change(key, e.target.value)} required autoComplete={autoComplete}
          inputMode={key === 'npi' ? 'numeric' : 'text'} maxLength={key === 'npi' ? 10 : 100}
          pattern={key === 'npi' ? '[0-9]{10}' : undefined} style={inputStyle} />
      </label>)}
      {error && <p role="alert" style={{ color: 'var(--color-domain-vascular)', lineHeight: 1.5 }}>{error}</p>}
      {match && <p role="status" style={{ color: 'var(--color-verified-soft)' }}>NPI matched</p>}
      {preview && <p style={{ color: 'var(--color-fg-dim)' }}>Preview only — NPI is not checked or saved.</p>}
      <div style={{ marginTop: 24 }}>
        {match || preview
          ? <button type="button" onClick={() => onContinue?.(match)} style={buttonStyle}>Continue →</button>
          : <button type="submit" disabled={busy} style={{ ...buttonStyle, opacity: busy ? 0.6 : 1 }}>{busy ? 'Checking…' : 'Match NPI'}</button>}
        {onBack && <button type="button" onClick={onBack} style={{ marginLeft: 18, border: 0, background: 'transparent', color: 'var(--color-fg-dim)' }}>Back</button>}
      </div>
    </form>
    {!match && <NoNpiContact />}
  </div>
}
